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

    // Step 4: Deploy agent code
    progress(&app, "Deploying agent code...");
    let agent_src = resolve_agent_source(&app)?;
    if let Err(e) = deploy_agent_code(&data_dir, &agent_src) {
        let msg = format!("setup_agent: deploy failed: {}", e);
        logging::error(&msg);
        return Err(msg);
    }
    logging::info("setup_agent: agent code deployed");

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
        crate::state::AgentMode::Deployed | crate::state::AgentMode::Remote => {
            // Deployed/Remote: just clear the URL, sandbox keeps running
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

    let start_cmd = format!("cd /data/agent && {} node dist/index.js > /data/logs/agent.log 2>&1 &", env_parts);
    logging::info(&format!(
        "start_agent_process: vm={} provider={} model={} (keys redacted)",
        vm_name,
        provider,
        if provider == "openrouter" { &config.openrouter_model } else { &config.model },
    ));

    match heyvm::exec_in_sandbox(vm_name, &["sh", "-c", &start_cmd]) {
        Ok(out) => logging::info(&format!("start_agent_process: exec returned: {}", out.trim())),
        Err(e) => logging::warn(&format!("start_agent_process: exec error (may be fine for background): {}", e)),
    }
}

fn shell_escape(s: &str) -> String {
    // Wrap in single quotes; any embedded single-quote becomes '\''
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Update the agent code by recreating the sandbox.
///
/// **Why recreate, not in-place update?** The KVM/firecracker `--mount` is a
/// point-in-time snapshot (block device, not a live bind mount) — writes to the
/// host directory after sandbox creation never reach the guest. The only way
/// the guest sees fresh agent code is to be created with a fresh snapshot.
///
/// Flow: drop port-forward + cached URL → `heyvm rm` → re-run setup (which
/// rebuilds the image if missing, snapshots the now-up-to-date host
/// `~/.todo/agent`, creates the sandbox, npm-installs, starts, and reconnects).
#[tauri::command]
pub async fn update_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    logging::info("=== update_agent: starting ===");

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

    progress(&app, "Disconnecting from agent...");
    state.kill_port_forward();
    *state.agent_url.lock().unwrap() = None;
    let _ = app.emit("agent-status", "disconnected");

    progress(&app, "Refreshing agent code on host...");
    let agent_src = resolve_agent_source(&app)?;
    if let Err(e) = deploy_agent_code(&data_dir, &agent_src) {
        let msg = format!("update_agent: host refresh failed: {}", e);
        logging::error(&msg);
        return Err(msg);
    }

    if heyvm::sandbox_exists(&vm_name) {
        progress(&app, &format!("Removing sandbox '{}'...", vm_name));
        if let Err(e) = heyvm::rm_sandbox(&vm_name) {
            logging::warn(&format!("update_agent: rm sandbox returned error (continuing): {}", e));
        }
    }

    // setup_agent (the existing flow) does: ensure dirs → check image → create
    // sandbox with snapshot of host `data_dir` → start → npm install → start
    // agent → wait. With the sandbox just removed it will create it fresh.
    setup_agent(state, app).await
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

    // Check for persisted deployment (deployed or remote mode)
    let deploy_info = state.load_deployment_info();
    if deploy_info.mode != crate::state::AgentMode::Local {
        if let Some(ref url) = deploy_info.public_url {
            logging::info(&format!("auto_start: found persisted {:?} deployment at {}", deploy_info.mode, url));
            let _ = app.emit("agent-status", "starting");

            if svc::check_health(url).await {
                *state.agent_url.lock().unwrap() = Some(url.clone());
                state.apply_deployment(&deploy_info);
                let _ = app.emit("agent-status", "running");
                logging::info(&format!("auto_start: reconnected to {} deployment at {}",
                    if deploy_info.mode == crate::state::AgentMode::Deployed { "deployed" } else { "remote" }, url));
                return;
            } else {
                logging::warn(&format!("auto_start: persisted deployment at {} not healthy", url));
                // Keep deployment info so user can retry, but report error
                state.apply_deployment(&deploy_info);
                let _ = app.emit("agent-status", "error");
                return;
            }
        }
    }

    // Local mode: existing auto-start logic
    let config = read_config(&state);

    if config.api_key.is_empty() {
        logging::info("auto_start: no API key configured, skipping");
        return;
    }

    let vm_name = if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() };

    if !heyvm::sandbox_exists(&vm_name) {
        logging::info(&format!("auto_start: sandbox '{}' does not exist, skipping", vm_name));
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
