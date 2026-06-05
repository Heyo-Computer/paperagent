use tauri::{State, AppHandle, Emitter, Manager};
use crate::models::agent::AgentMessage;
use crate::services::agent as svc;
use crate::services::heyvm;
use crate::state::AppState;
use crate::logging;

const AGENT_PORT: u16 = 8080;
const AGENT_IMAGE_NAME: &str = "todo-agent";
const AGENT_DOCKERFILE: &str = "Dockerfile.firecracker";

/// Path the firecracker/kvm rootfs lives at when built.
fn agent_image_path() -> std::path::PathBuf {
    let home = dirs::home_dir().expect("Could not determine home directory");
    home.join(".heyo/images/firecracker")
        .join(format!("{}.ext4", AGENT_IMAGE_NAME))
}

/// Whether the named backend uses firecracker-style ext4 images at
/// `~/.heyo/images/firecracker/<name>.ext4`.
fn backend_uses_firecracker_image(backend: &str) -> bool {
    matches!(backend, "firecracker" | "kvm")
}

fn agent_url() -> String {
    format!("http://localhost:{}", AGENT_PORT)
}

fn read_config(state: &AppState) -> crate::commands::config::AgentConfig {
    crate::commands::config::AgentConfig::default_from_disk(&state.config_dir)
}

/// Full setup workflow: ensure dirs -> create sandbox -> start -> deploy agent -> start agent -> wait
#[tauri::command]
pub async fn setup_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    logging::info("=== setup_agent: starting ===");

    let config = read_config(&state);
    let vm_name = if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() };
    let backend = if config.vm_backend.is_empty() {
        if cfg!(target_os = "macos") { "apple_vf" } else { "libvirt" }.to_string()
    } else {
        config.vm_backend.clone()
    };
    let data_dir = if config.data_dir.is_empty() {
        state.data_dir.to_string_lossy().to_string()
    } else {
        config.data_dir.clone()
    };

    logging::info(&format!("setup_agent: vm_name={}, backend={}, data_dir={}", vm_name, backend, data_dir));
    logging::info(&format!("setup_agent: model={}, api_key_set={}", config.model, !config.api_key.is_empty()));

    // Step 1: Ensure data directory
    progress(&app, "Creating data directory...");
    for sub in &["storage", "artifacts", "config", "logs"] {
        let p = format!("{}/{}", data_dir, sub);
        if let Err(e) = std::fs::create_dir_all(&p) {
            let msg = format!("setup_agent: failed to create {}: {}", p, e);
            logging::error(&msg);
            return Err(msg);
        }
    }
    logging::info("setup_agent: data directories created");

    // Step 2: Ensure VM image exists (build via heyvm mvm if missing for firecracker/kvm)
    let image_arg: Option<String> = if backend_uses_firecracker_image(&backend) {
        let image_path = agent_image_path();
        if !image_path.exists() {
            progress(&app, &format!("Building VM image '{}' (first run)...", AGENT_IMAGE_NAME));
            let dockerfile = resolve_dockerfile(&app)?;
            if let Err(e) = heyvm::build_image(&dockerfile, AGENT_IMAGE_NAME) {
                let msg = format!("setup_agent: image build failed: {}", e);
                logging::error(&msg);
                return Err(msg);
            }
            logging::info(&format!("setup_agent: built image {} at {}", AGENT_IMAGE_NAME, image_path.display()));
        } else {
            logging::info(&format!("setup_agent: image {} present at {}", AGENT_IMAGE_NAME, image_path.display()));
        }
        Some(AGENT_IMAGE_NAME.to_string())
    } else {
        // libvirt / apple_vf: look for a qcow2 image at the standard location.
        // Prefer `<image>-base.qcow2` (heyvm libvirt convention) over `<image>.qcow2`.
        let home = dirs::home_dir().expect("Could not determine home directory");
        let candidates = [
            home.join(".heyo/images").join(format!("{}-base.qcow2", AGENT_IMAGE_NAME)),
            home.join(".heyo/images").join(format!("{}.qcow2", AGENT_IMAGE_NAME)),
        ];
        let found = candidates.iter().find(|p| p.exists()).cloned();
        match found {
            Some(p) => {
                logging::info(&format!("setup_agent: using libvirt image at {}", p.display()));
                Some(p.to_string_lossy().to_string())
            }
            None => {
                let msg = format!(
                    "setup_agent: no libvirt image found. Looked for: {}",
                    candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "),
                );
                logging::error(&msg);
                return Err(msg);
            }
        }
    };

    // Deploy agent code to the host data dir BEFORE create, so the `--mount`
    // seed copies it into the VM's /data/agent at creation. (Under KVM, host
    // writes after creation don't reach the guest, so seeding is how first-run
    // code gets in; updates use the in-place push in `update_agent`.)
    progress(&app, "Preparing agent code...");
    let agent_src = resolve_agent_source(&app)?;
    if let Err(e) = deploy_agent_code(&data_dir, &agent_src) {
        let msg = format!("setup_agent: deploy failed: {}", e);
        logging::error(&msg);
        return Err(msg);
    }
    logging::info("setup_agent: agent code staged for seed");

    // Step 3: Create sandbox with agent port forwarded to host
    progress(&app, "Checking sandbox...");
    if heyvm::sandbox_exists(&vm_name) {
        logging::info(&format!("setup_agent: sandbox '{}' already exists", vm_name));
    } else {
        progress(&app, &format!("Creating sandbox '{}'...", vm_name));
        match heyvm::create_sandbox_with_backend(&vm_name, &backend, &data_dir, image_arg.as_deref(), &[(AGENT_PORT, AGENT_PORT)]) {
            Ok(result) => {
                if let Some(mapping) = result.port_mappings.first() {
                    logging::info(&format!("setup_agent: sandbox created, port mapping: host:{} -> guest:{}",
                        mapping.host_port, mapping.guest_port));
                } else {
                    logging::info("setup_agent: sandbox created (no port mappings returned)");
                }
            }
            Err(e) => {
                let msg = format!("setup_agent: create sandbox failed: {}", e);
                logging::error(&msg);
                return Err(msg);
            }
        }
    }
    *state.vm_name.lock().unwrap() = Some(vm_name.clone());

    // Step 3: Start sandbox
    progress(&app, "Starting sandbox...");
    match heyvm::start_sandbox(&vm_name) {
        Ok(out) => logging::info(&format!("setup_agent: start sandbox: {}", out.trim())),
        Err(e) => logging::warn(&format!("setup_agent: start sandbox returned error (may already be running): {}", e)),
    }

    // Hardening: the `--mount` seed copied the host config (incl. api_key) into the
    // VM, which would then travel with `heyvm sync`. The agent reads the key from
    // env, not this file, so scrub secrets from the in-VM copy.
    let scrub = "node -e 'try{const f=\"/data/config/agent.json\";const c=JSON.parse(require(\"fs\").readFileSync(f));for(const k of [\"api_key\",\"openrouter_api_key\",\"heyo_api_key\",\"speech_api_key\"])delete c[k];require(\"fs\").writeFileSync(f,JSON.stringify(c,null,2))}catch(e){}'";
    let _ = heyvm::exec_in_sandbox(&vm_name, &["sh", "-c", scrub]);

    // Step 5: Install dependencies
    if let Err(e) = npm_install_agent(&vm_name, &app).await {
        let msg = format!("setup_agent: {}", e);
        logging::error(&msg);
        return Err(msg);
    }

    // Step 6: Start the agent service
    progress(&app, "Starting agent service...");
    start_agent_process(&vm_name, &config);

    // Step 7+8: Poll the host-reachable URL until the agent responds.
    // This replaces the `heyvm wait-for` step (which uses an internal mechanism
    // that times out on KVM even when the agent is up) with a direct host probe.
    progress(&app, "Waiting for agent to be ready...");
    logging::info(&format!("setup_agent: polling agent health on port {}", AGENT_PORT));
    match wait_for_agent(&vm_name, &app, &state).await {
        Ok(url) => {
            *state.agent_url.lock().unwrap() = Some(url.clone());
            let _ = app.emit("agent-status", "running");
            logging::info(&format!("setup_agent: agent ready at {}", url));
            logging::info("=== setup_agent: complete ===");
            Ok(format!("Agent ready in sandbox '{}'", vm_name))
        }
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            logging::error(&format!("setup_agent: connection failed: {}", e));
            logging::info("=== setup_agent: failed ===");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn start_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    logging::info("start_agent: starting");
    let _ = app.emit("agent-status", "starting");

    let config = read_config(&state);
    let vm_name = {
        let lock = state.vm_name.lock().unwrap();
        lock.clone()
    }.unwrap_or_else(|| {
        if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() }
    });

    logging::info(&format!("start_agent: vm={}, provider={}", vm_name, config.llm_provider));
    start_agent_process(&vm_name, &config);

    match wait_for_agent(&vm_name, &app, &state).await {
        Ok(url) => {
            *state.agent_url.lock().unwrap() = Some(url);
            let _ = app.emit("agent-status", "running");
            logging::info("start_agent: agent ready");
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn stop_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    logging::info("stop_agent: stopping");

    let mode = state.agent_mode.lock().unwrap().clone();

    match mode {
        crate::state::AgentMode::Local => {
            // Local mode: send stop RPC and kill port-forward
            let url = state.agent_url.lock().unwrap().clone();
            if let Some(url) = url {
                let _ = svc::send_rpc(&url, "agent/stop", serde_json::Value::Null).await;
            }
            state.kill_port_forward();
            *state.agent_url.lock().unwrap() = None;
        }
        crate::state::AgentMode::P2p => {
            // P2P: stop the supervisor and tear down the iroh tunnel; the
            // remote sandbox keeps running (it's not ours).
            state.stop_supervisor();
            state.drop_p2p_tunnel();
            *state.agent_url.lock().unwrap() = None;
        }
        crate::state::AgentMode::Deployed | crate::state::AgentMode::Remote => {
            // Deployed/Remote: stop the supervisor and clear the URL; the
            // sandbox keeps running.
            state.stop_supervisor();
            *state.agent_url.lock().unwrap() = None;
        }
    }

    let _ = app.emit("agent-status", "disconnected");
    logging::info("stop_agent: done");
    Ok(())
}

#[tauri::command]
pub async fn send_message(
    message: String,
    state: State<'_, AppState>,
) -> Result<AgentMessage, String> {
    let url = {
        let lock = state.agent_url.lock().unwrap();
        lock.clone()
    };

    let url = url.ok_or("Agent is not running. Use the status popover to set up the agent.")?;
    logging::info(&format!("send_message: sending {} chars to {}", message.len(), url));
    let result = svc::send_chat_message(&url, &message).await;
    match &result {
        Ok(msg) => logging::info(&format!("send_message: got response, {} chars", msg.content.len())),
        Err(e) => logging::error(&format!("send_message: error: {}", e)),
    }
    result
}

#[tauri::command]
pub async fn agent_status(state: State<'_, AppState>) -> Result<String, String> {
    let url = {
        let lock = state.agent_url.lock().unwrap();
        lock.clone()
    };

    match url {
        Some(url) => {
            if svc::check_health(&url).await {
                Ok("running".to_string())
            } else {
                Ok("error".to_string())
            }
        }
        None => Ok("disconnected".to_string()),
    }
}

#[tauri::command]
pub fn get_chat_history(
    date: String,
    state: State<AppState>,
) -> Vec<AgentMessage> {
    let dir = crate::services::storage::day_dir(&state.storage_root, &date);
    let path = dir.join("chat.json");

    if let Ok(content) = std::fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    }
}

/// Run `npm install --omit=dev` in /data/agent without holding open a long
/// `heyvm exec` call — each individual exec stays under the heyvm serial
/// console's 30s hard limit. Fires off a backgrounded install with a marker
/// file, then polls the marker.
///
/// Skips work entirely if node_modules already exists and package.json
/// hasn't changed since the last install.
async fn npm_install_agent(
    vm_name: &str,
    app: &AppHandle,
) -> Result<(), String> {
    let probe = "cd /data/agent && \
        sha256sum package.json 2>/dev/null > /data/.pkg-hash-new; \
        if [ -d node_modules ] && [ -s /data/.pkg-hash ] && \
           cmp -s /data/.pkg-hash /data/.pkg-hash-new 2>/dev/null; then \
            echo SKIP; \
        else \
            mv -f /data/.pkg-hash-new /data/.pkg-hash 2>/dev/null; \
            echo NEED; \
        fi";
    match heyvm::exec_in_sandbox_json(vm_name, &["sh", "-c", probe], Some("15s")) {
        Ok(out) if out.stdout.trim() == "SKIP" => {
            logging::info("npm_install_agent: package.json unchanged, skipping install");
            return Ok(());
        }
        Ok(_) => logging::info("npm_install_agent: install needed"),
        Err(e) => {
            logging::warn(&format!("npm_install_agent: probe failed, will attempt install anyway: {}", e));
        }
    }

    progress(app, "Installing agent dependencies (in background)...");
    let kickoff = "rm -f /data/.npm-done /data/.npm-running && \
        nohup sh -c 'touch /data/.npm-running; \
            cd /data/agent && npm install --omit=dev > /data/logs/npm.log 2>&1; \
            echo $? > /data/.npm-done; \
            rm -f /data/.npm-running' \
        > /dev/null 2>&1 &";
    if let Err(e) = heyvm::exec_in_sandbox_json(vm_name, &["sh", "-c", kickoff], Some("15s")) {
        return Err(format!("npm_install_agent: failed to kick off install: {}", e));
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    let mut last_progress = std::time::Instant::now();
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let res = heyvm::exec_in_sandbox_json(
            vm_name,
            &["sh", "-c", "cat /data/.npm-done 2>/dev/null"],
            Some("15s"),
        );
        match res {
            Ok(out) => {
                let code = out.stdout.trim();
                if !code.is_empty() {
                    if code == "0" {
                        logging::info("npm_install_agent: install finished, exit 0");
                        return Ok(());
                    }
                    let log_tail = heyvm::exec_in_sandbox_json(
                        vm_name,
                        &["sh", "-c", "tail -30 /data/logs/npm.log 2>&1"],
                        Some("10s"),
                    ).map(|o| o.stdout).unwrap_or_default();
                    return Err(format!("npm install failed (exit {}): {}", code, tail(&log_tail, 400)));
                }
                if last_progress.elapsed() > std::time::Duration::from_secs(15) {
                    progress(app, "Still installing dependencies...");
                    last_progress = std::time::Instant::now();
                }
            }
            Err(e) => {
                logging::warn(&format!("npm_install_agent: marker poll error (will retry): {}", e));
            }
        }
    }
    Err("npm install timed out after 5 minutes".to_string())
}

/// Build the agent's start command using the configured provider, then exec
/// it in the sandbox as a background process. Logs but does not return errors —
/// the caller relies on `wait_for_agent` to confirm health.
fn start_agent_process(vm_name: &str, config: &crate::commands::config::AgentConfig) {
    let provider = if config.llm_provider.is_empty() { "anthropic" } else { &config.llm_provider };
    let mut env_parts = format!("PORT={} LLM_PROVIDER={}", AGENT_PORT, provider);

    if provider == "openrouter" {
        if !config.openrouter_api_key.is_empty() {
            env_parts.push_str(&format!(" OPENROUTER_API_KEY={}", shell_escape(&config.openrouter_api_key)));
        }
        if !config.openrouter_model.is_empty() {
            env_parts.push_str(&format!(" OPENROUTER_MODEL={}", shell_escape(&config.openrouter_model)));
        }
    } else {
        if !config.api_key.is_empty() {
            env_parts.push_str(&format!(" ANTHROPIC_API_KEY={}", shell_escape(&config.api_key)));
        }
        if !config.model.is_empty() {
            env_parts.push_str(&format!(" ANTHROPIC_MODEL={}", shell_escape(&config.model)));
        }
    }

    // Prompt config travels via env: under KVM the host can't write the agent's
    // /data/config/agent.json (no live mount), so spec verbosity + user context are
    // passed at start. The agent prefers these over the seeded config file.
    if !config.spec_verbosity.is_empty() {
        env_parts.push_str(&format!(" SPEC_VERBOSITY={}", shell_escape(&config.spec_verbosity)));
    }
    if !config.user_context.is_empty() {
        env_parts.push_str(&format!(" USER_CONTEXT={}", shell_escape(&config.user_context)));
    }

    // Detach the long-lived agent properly: env prefix → `nohup sh -c '<node>'`
    // (the inner command has no quotes, so the single-quoted env values above don't
    // need to nest), redirect to /dev/null, background. A plain `&` over the KVM
    // serial console keeps the exec session open and times out ("Terminated"), so
    // we also use the json/timeout exec path (same as npm install).
    let start_cmd = format!(
        "cd /data/agent && {} nohup sh -c 'node dist/index.js > /data/logs/agent.log 2>&1' > /dev/null 2>&1 &",
        env_parts
    );
    logging::info(&format!(
        "start_agent_process: vm={} provider={} model={} (keys redacted)",
        vm_name,
        provider,
        if provider == "openrouter" { &config.openrouter_model } else { &config.model },
    ));

    match heyvm::exec_in_sandbox_json(vm_name, &["sh", "-c", &start_cmd], Some("15s")) {
        Ok(out) => logging::info(&format!("start_agent_process: kicked (exit {}): {}", out.exit_code, out.stdout.trim())),
        Err(e) => logging::warn(&format!("start_agent_process: exec error (may be fine for background): {}", e)),
    }
}

fn shell_escape(s: &str) -> String {
    // Wrap in single quotes; any embedded single-quote becomes '\''
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Tar the agent source and push it into a running sandbox at /data/agent over
/// SSH (ssh-proxy), then extract. This is the non-destructive code-update path:
/// the VM's /data (the unit of truth) is preserved. `heyvm exec` can't carry the
/// payload (no stdin; the serial console times out on large args), so we scp.
fn push_agent_code(vm_name: &str, agent_src: &std::path::Path) -> Result<(), String> {
    if !agent_src.join("dist/index.js").exists() {
        return Err(format!("agent dist/index.js not found at {}", agent_src.display()));
    }
    let tmp = std::env::temp_dir().join(format!("todo-agent-{}.tgz", std::process::id()));
    let status = std::process::Command::new("tar")
        .arg("czf").arg(&tmp)
        .arg("-C").arg(agent_src)
        .arg("--exclude=node_modules")
        .arg("--exclude=.git")
        .arg(".")
        .status()
        .map_err(|e| format!("tar spawn failed: {}", e))?;
    if !status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err("tar failed to package agent code".to_string());
    }

    let result = (|| -> Result<(), String> {
        heyvm::scp_into_sandbox(vm_name, &tmp, "/tmp/agent-upload.tgz")?;
        heyvm::exec_in_sandbox(vm_name, &["sh", "-c",
            "rm -rf /data/agent && mkdir -p /data/agent && \
             tar xzf /tmp/agent-upload.tgz -C /data/agent && \
             rm -f /tmp/agent-upload.tgz && test -f /data/agent/dist/index.js"])?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Stop the running agent process and start it fresh (picks up new code/env).
fn restart_agent(vm_name: &str, config: &crate::commands::config::AgentConfig) {
    let _ = heyvm::exec_in_sandbox(vm_name, &["sh", "-c", "pkill -f 'node dist/index.js' || true"]);
    start_agent_process(vm_name, config);
}

/// Update the agent **in place**: push fresh code into the running VM and restart,
/// leaving /data (the unit of truth) intact. Falls back to a safe export→recreate
/// if the in-place path fails for any reason.
#[tauri::command]
pub async fn update_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    logging::info("=== update_agent: starting (in-place) ===");

    let config = read_config(&state);
    let vm_name = {
        let lock = state.vm_name.lock().unwrap();
        lock.clone()
    }.unwrap_or_else(|| {
        if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() }
    });

    // No sandbox yet → there's nothing to update in place; do a full setup.
    if !heyvm::sandbox_exists(&vm_name) {
        logging::info("update_agent: no sandbox — running full setup");
        return setup_agent(app.state::<AppState>(), app.clone()).await;
    }

    let _ = heyvm::start_sandbox(&vm_name);
    *state.vm_name.lock().unwrap() = Some(vm_name.clone());

    let agent_src = match resolve_agent_source(&app) {
        Ok(p) => p,
        Err(e) => return Err(e),
    };

    progress(&app, "Pushing updated agent code into the sandbox...");
    match push_agent_code(&vm_name, &agent_src) {
        Ok(_) => {
            if let Err(e) = npm_install_agent(&vm_name, &app).await {
                logging::warn(&format!("update_agent: npm install failed in-place ({}); recreating", e));
                return update_agent_recreate(state, app).await;
            }
            progress(&app, "Restarting agent...");
            restart_agent(&vm_name, &config);
            match wait_for_agent(&vm_name, &app, &state).await {
                Ok(url) => {
                    *state.agent_url.lock().unwrap() = Some(url);
                    let _ = app.emit("agent-status", "running");
                    logging::info("=== update_agent: complete (in-place) ===");
                    Ok("Agent updated in place".to_string())
                }
                Err(e) => {
                    logging::warn(&format!("update_agent: agent didn't return after in-place update ({}); recreating", e));
                    update_agent_recreate(state, app).await
                }
            }
        }
        Err(e) => {
            logging::warn(&format!("update_agent: in-place push failed ({}); recreating", e));
            progress(&app, "In-place update unavailable; rebuilding sandbox safely...");
            update_agent_recreate(state, app).await
        }
    }
}

/// Fallback updater: export the VM's data to `~/.todo` first (so no data is lost),
/// then recreate the sandbox, which reseeds `/data` from that fresh export.
async fn update_agent_recreate(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    logging::info("=== update_agent_recreate: starting ===");

    let config = read_config(&state);
    let vm_name = {
        let lock = state.vm_name.lock().unwrap();
        lock.clone()
    }.unwrap_or_else(|| {
        if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() }
    });
    let data_dir = if config.data_dir.is_empty() {
        state.data_dir.to_string_lossy().to_string()
    } else {
        config.data_dir.clone()
    };

    // Export VM data → host so the recreate reseeds from current data (the VM is the
    // unit of truth; preserve writes made since creation).
    progress(&app, "Backing up sandbox data to ~/.todo...");
    if let Err(e) = crate::commands::migration::export_to_local(&state).await {
        logging::warn(&format!("update_agent_recreate: export failed (continuing): {}", e));
    }

    progress(&app, "Disconnecting from agent...");
    state.kill_port_forward();
    *state.agent_url.lock().unwrap() = None;
    let _ = app.emit("agent-status", "disconnected");

    progress(&app, "Refreshing agent code on host...");
    let agent_src = resolve_agent_source(&app)?;
    if let Err(e) = deploy_agent_code(&data_dir, &agent_src) {
        let msg = format!("update_agent_recreate: host refresh failed: {}", e);
        logging::error(&msg);
        return Err(msg);
    }

    if heyvm::sandbox_exists(&vm_name) {
        progress(&app, &format!("Removing sandbox '{}'...", vm_name));
        if let Err(e) = heyvm::rm_sandbox(&vm_name) {
            logging::warn(&format!("update_agent_recreate: rm returned error (continuing): {}", e));
        }
    }

    // setup_agent reseeds /data from the just-exported ~/.todo, then starts fresh.
    setup_agent(state, app).await
}

/// Adopt an existing sandbox as the agent VM and connect to it — without
/// provisioning or seeding. Supports the "I synced my VM to another workstation"
/// flow: `heyvm sync pull` lands a self-contained VM (data + agent code in /data),
/// and this points the app at it. Persists `vm_name` so future launches reuse it.
#[tauri::command]
pub async fn use_existing_vm(
    vm_name: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let vm_name = vm_name.trim().to_string();
    if vm_name.is_empty() {
        return Err("No VM selected".to_string());
    }
    logging::info(&format!("use_existing_vm: adopting '{}'", vm_name));
    let _ = app.emit("agent-status", "starting");

    if !heyvm::sandbox_exists(&vm_name) {
        let _ = app.emit("agent-status", "error");
        return Err(format!("Sandbox '{}' not found", vm_name));
    }

    // Persist vm_name so auto_start uses it on future launches.
    let mut config = read_config(&state);
    config.vm_name = vm_name.clone();
    if let Err(e) = write_config(&state, &config) {
        logging::warn(&format!("use_existing_vm: failed to persist vm_name: {}", e));
    }
    *state.vm_name.lock().unwrap() = Some(vm_name.clone());

    // Start the sandbox (it may be stopped after a sync pull), then the agent
    // process. We trust the VM's synced /data/agent code — use "Update Agent" to
    // push this machine's agent version if they differ.
    progress(&app, &format!("Starting VM '{}'...", vm_name));
    match heyvm::start_sandbox(&vm_name) {
        Ok(out) => logging::info(&format!("use_existing_vm: start: {}", out.trim())),
        Err(e) => logging::warn(&format!("use_existing_vm: start returned error (may already be running): {}", e)),
    }

    progress(&app, "Starting agent service...");
    // restart (pkill + start) so adopting an already-running VM doesn't leave a
    // duplicate node fighting for the port.
    restart_agent(&vm_name, &config);

    match wait_for_agent(&vm_name, &app, &state).await {
        Ok(url) => {
            *state.agent_url.lock().unwrap() = Some(url);
            let _ = app.emit("agent-status", "running");
            logging::info(&format!("use_existing_vm: connected to '{}'", vm_name));
            Ok(format!("Connected to existing VM '{}'", vm_name))
        }
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            logging::error(&format!("use_existing_vm: connection failed: {}", e));
            Err(e)
        }
    }
}

/// Persist the agent config to disk (mirrors set_agent_config's write).
fn write_config(state: &AppState, config: &crate::commands::config::AgentConfig) -> Result<(), String> {
    std::fs::create_dir_all(&state.config_dir).map_err(|e| e.to_string())?;
    let path = state.config_dir.join("agent.json");
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Poll `establish_host_connection` until it succeeds or 30s elapses.
/// Replaces `heyvm wait-for`, which is unreliable on the KVM backend.
async fn wait_for_agent(
    vm_name: &str,
    app: &AppHandle,
    state: &AppState,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut last_err = String::from("agent did not come up");

    while std::time::Instant::now() < deadline {
        match establish_host_connection(vm_name, state).await {
            Ok(url) => return Ok(url),
            Err(e) => last_err = e,
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    let agent_log = match heyvm::exec_in_sandbox_json(vm_name, &["sh", "-c", "tail -30 /data/logs/agent.log 2>&1"], Some("5s")) {
        Ok(out) => out.stdout,
        Err(e) => format!("(could not read agent log: {})", e),
    };
    logging::error(&format!("wait_for_agent: timed out: {}. Agent log:\n{}", last_err, agent_log));
    let _ = app.emit("agent-status", "error");
    Err(format!("Agent failed to respond within 30 seconds. Check ~/.todo/logs/todo.log and ~/.todo/logs/agent.log for details."))
}

/// After wait-for confirms the agent is running inside the sandbox,
/// verify the host can reach it. Tries (in order):
///   1. localhost:AGENT_PORT — works when --open-port actually NATted
///   2. KVM/Firecracker guest tap IP — `--open-port` is a no-op for these backends
///   3. `heyvm port-forward` — fallback for older libvirt sandboxes
async fn establish_host_connection(
    vm_name: &str,
    state: &AppState,
) -> Result<String, String> {
    let local_url = agent_url();

    if svc::check_health(&local_url).await {
        logging::info(&format!("establish_connection: direct localhost works at {}", local_url));
        return Ok(local_url);
    }

    // For KVM/Firecracker, the agent is reachable on the tap device's guest IP.
    if let Some(guest_ip) = heyvm::kvm_guest_ip(vm_name) {
        let guest_url = format!("http://{}:{}", guest_ip, AGENT_PORT);
        if svc::check_health(&guest_url).await {
            logging::info(&format!("establish_connection: guest IP works at {}", guest_url));
            return Ok(guest_url);
        }
        logging::warn(&format!("establish_connection: guest IP {} unreachable, falling back", guest_url));
    }

    logging::info("establish_connection: trying heyvm port-forward fallback");
    state.kill_port_forward();
    let child = heyvm::port_forward(vm_name, AGENT_PORT, Some(AGENT_PORT))?;
    *state.port_forward_child.lock().unwrap() = Some(child);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    if svc::check_health(&local_url).await {
        logging::info(&format!("establish_connection: port-forward working at {}", local_url));
        Ok(local_url)
    } else {
        Err("Agent is running inside sandbox but host cannot reach it. Try deleting and recreating the sandbox.".to_string())
    }
}

/// Try to auto-start the agent on app boot. Called from the Tauri setup hook.
/// Checks for persisted deployment info first; falls back to local sandbox auto-start.
/// Failures are logged but not propagated — the user can always start manually.
pub async fn auto_start_agent(app: AppHandle) {
    let state = app.state::<AppState>();

    // Reconnect to a persisted Deployed / P2P / Remote target, if any. This
    // re-establishes the P2P tunnel or health-checks the deployed URL and starts
    // the keep-alive supervisor where appropriate.
    if crate::commands::connection::resume_persisted(&app).await {
        return;
    }

    // Local mode. The sandbox is the single source of truth for data, so we start
    // it on every launch regardless of whether an LLM key is configured — the agent
    // serves storage RPCs keyless; the key only enables chat.
    let config = read_config(&state);
    let vm_name = if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() };

    if !heyvm::sandbox_exists(&vm_name) {
        // First launch (or a wiped sandbox): provision it end-to-end. setup_agent
        // builds the image if needed, creates+starts the sandbox, deploys the agent
        // code, installs deps, starts the agent process, and sets agent_url.
        logging::info(&format!("auto_start: sandbox '{}' missing — provisioning", vm_name));
        if let Err(e) = setup_agent(app.state::<AppState>(), app.clone()).await {
            logging::error(&format!("auto_start: provisioning failed: {}", e));
            let _ = app.emit("agent-status", "error");
        }
        return;
    }

    logging::info(&format!("auto_start: attempting to start agent in '{}'", vm_name));
    let _ = app.emit("agent-status", "starting");

    // Start sandbox
    match heyvm::start_sandbox(&vm_name) {
        Ok(out) => logging::info(&format!("auto_start: start sandbox: {}", out.trim())),
        Err(e) => logging::warn(&format!("auto_start: start sandbox error (may already be running): {}", e)),
    }
    *state.vm_name.lock().unwrap() = Some(vm_name.clone());

    start_agent_process(&vm_name, &config);

    match wait_for_agent(&vm_name, &app, &state).await {
        Ok(url) => {
            *state.agent_url.lock().unwrap() = Some(url.clone());
            let _ = app.emit("agent-status", "running");
            logging::info(&format!("auto_start: agent ready at {}", url));
        }
        Err(e) => {
            logging::warn(&format!("auto_start: connection failed: {}", e));
            let _ = app.emit("agent-status", "error");
        }
    }
}

// ── Helpers ──

fn progress(app: &AppHandle, msg: &str) {
    logging::info(&format!("setup_agent: {}", msg));
    let _ = app.emit("setup-progress", msg.to_string());
}

fn tail(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        s.trim()
    } else {
        s[s.len() - max_chars..].trim()
    }
}

/// Resolve the Firecracker/KVM Dockerfile path. Tries the bundled resource
/// dir first, then `agent-bundle/`, then the dev `agent/` source tree.
pub fn resolve_dockerfile(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("agent-bundle").join(AGENT_DOCKERFILE));
        candidates.push(resource_dir.join(AGENT_DOCKERFILE));
    }
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../agent")
        .join(AGENT_DOCKERFILE);
    candidates.push(dev_path);

    for path in &candidates {
        if path.exists() {
            logging::info(&format!("resolve_dockerfile: using {}", path.display()));
            return Ok(path.clone());
        }
    }

    Err(format!(
        "Dockerfile '{}' not found. Looked in: {}",
        AGENT_DOCKERFILE,
        candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
    ))
}

/// Resolve the agent source directory.
///
/// In debug builds, prefer the source tree at `<crate>/../agent` — Tauri's
/// `beforeBuildCommand` that produces `agent-bundle/` only runs on
/// `tauri build`, so the bundled copy is stale during `tauri dev`.
///
/// In release builds, prefer the bundled resource.
pub fn resolve_agent_source(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent");

    if cfg!(debug_assertions) && dev_path.join("dist/index.js").exists() {
        logging::info(&format!("resolve_agent_source: using dev path at {} (debug build)", dev_path.display()));
        return Ok(dev_path);
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("agent-bundle");
        if bundled.join("dist/index.js").exists() {
            logging::info(&format!("resolve_agent_source: using bundled resource at {}", bundled.display()));
            return Ok(bundled);
        }
    }

    if dev_path.join("dist/index.js").exists() {
        logging::info(&format!("resolve_agent_source: using dev path at {}", dev_path.display()));
        return Ok(dev_path);
    }

    Err("Agent source not found. In production, ensure agent-bundle/ is included in Tauri resources. In dev, ensure agent/ exists at the project root and `bun run build` has been run.".to_string())
}

/// Copy the agent/ directory into the data dir so it's accessible inside the VM at /data/agent
fn deploy_agent_code(data_dir: &str, agent_src: &std::path::Path) -> Result<(), String> {
    let agent_dst = std::path::Path::new(data_dir).join("agent");

    logging::info(&format!("deploy_agent_code: src={}, dst={}", agent_src.display(), agent_dst.display()));

    if !agent_src.exists() {
        return Err(format!("Agent source not found at {}", agent_src.display()));
    }

    let entries: Vec<_> = std::fs::read_dir(&agent_src)
        .map_err(|e| format!("Cannot read agent src: {}", e))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    logging::info(&format!("deploy_agent_code: src contents: {:?}", entries));

    copy_dir_recursive(&agent_src, &agent_dst).map_err(|e| format!("Failed to deploy agent: {}", e))?;

    let index_js = agent_dst.join("dist/index.js");
    let pkg_json = agent_dst.join("package.json");
    logging::info(&format!("deploy_agent_code: dist/index.js exists={}, package.json exists={}",
        index_js.exists(), pkg_json.exists()));

    if !index_js.exists() {
        return Err("Agent dist/index.js not found after deploy. Run 'tsc' in agent/ to build.".to_string());
    }

    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip node_modules and dotfiles (dist is kept -- pre-built)
        if name_str == "node_modules" || name_str.starts_with('.') {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&name);

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}
