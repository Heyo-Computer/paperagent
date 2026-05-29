use tauri::{State, AppHandle, Emitter};
use crate::services::agent as svc;
use crate::services::heyvm;
use crate::state::{AgentMode, AppState, DeploymentInfo};
use crate::logging;

const AGENT_PORT: u16 = 8080;

fn read_config(state: &AppState) -> crate::commands::config::AgentConfig {
    crate::commands::config::AgentConfig::default_from_disk(&state.config_dir)
}

fn progress(app: &AppHandle, msg: &str) {
    logging::info(&format!("deploy: {}", msg));
    let _ = app.emit("deploy-progress", msg.to_string());
}

/// Deploy the agent to Heyo cloud. Archives agent code, creates a cloud sandbox,
/// binds the port, and connects.
#[tauri::command]
pub async fn deploy_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    logging::info("=== deploy_agent: starting ===");

    let config = read_config(&state);

    // Validate prerequisites
    if config.api_key.is_empty() {
        return Err("Anthropic API key is required. Set it in Settings.".to_string());
    }
    if config.heyo_api_key.is_empty() {
        return Err("Heyo API key is required for cloud deployment. Set it in Settings.".to_string());
    }

    let cloud_url = if config.heyo_cloud_url.is_empty() {
        "https://server.heyo.computer".to_string()
    } else {
        config.heyo_cloud_url.clone()
    };
    let deploy_name = if config.vm_name.is_empty() {
        "todo-agent-cloud".to_string()
    } else {
        format!("{}-cloud", config.vm_name)
    };
    let image = if config.deploy_image.is_empty() {
        "ubuntu:24.04".to_string()
    } else {
        config.deploy_image.clone()
    };

    // Step 1: Archive agent code
    progress(&app, "Archiving agent code...");
    let agent_src = super::agent::resolve_agent_source(&app)?;
    let agent_path = agent_src.to_string_lossy().to_string();
    let archive_name = format!("todo-agent-{}", chrono::Utc::now().format("%Y%m%d-%H%M%S"));
    let archive_output = heyvm::archive_dir(&agent_path, &archive_name, "/data", &cloud_url)
        .map_err(|e| format!("Failed to archive agent code: {}", e))?;
    logging::info(&format!("deploy_agent: archive output: {}", archive_output.trim()));

    // Step 2: Create cloud sandbox
    progress(&app, "Creating cloud sandbox...");
    let port_str = AGENT_PORT.to_string();
    let opts = heyvm::CloudCreateOpts {
        name: &deploy_name,
        backend: "msb",
        cloud_url: &cloud_url,
        image: Some(&image),
        open_ports: &[(0, AGENT_PORT)],
        env_vars: &[
            ("PORT", &port_str),
            ("ANTHROPIC_API_KEY", &config.api_key),
            ("ANTHROPIC_MODEL", &config.model),
        ],
        setup_hooks: &["cd /data/agent && npm install --omit=dev"],
        start_command: Some("cd /data/agent && node dist/index.js"),
    };
    let create_result = heyvm::create_cloud_sandbox(&opts)
        .map_err(|e| format!("Failed to create cloud sandbox: {}", e))?;
    logging::info(&format!("deploy_agent: sandbox created: id={}, name={}", create_result.id, create_result.name));

    // Step 3: Start sandbox
    progress(&app, "Starting cloud sandbox...");
    match heyvm::start_sandbox(&deploy_name) {
        Ok(out) => logging::info(&format!("deploy_agent: start: {}", out.trim())),
        Err(e) => logging::warn(&format!("deploy_agent: start error (may auto-start): {}", e)),
    }

    // Step 4: Bind port to get public URL
    progress(&app, "Binding public URL...");
    let bind_output = heyvm::bind_port(&deploy_name, AGENT_PORT, &cloud_url)
        .map_err(|e| format!("Failed to bind port: {}", e))?;
    logging::info(&format!("deploy_agent: bind output: {}", bind_output.trim()));

    // Parse hostname from bind output — look for a hostname pattern
    let public_host = parse_bind_hostname(&bind_output, &deploy_name);
    let public_url = format!("https://{}", public_host);
    logging::info(&format!("deploy_agent: public URL: {}", public_url));

    // Step 5: Wait for agent to be reachable at the public URL
    progress(&app, "Waiting for agent to be ready...");
    let mut healthy = false;
    for attempt in 1..=20 {
        logging::info(&format!("deploy_agent: health check attempt {}/20", attempt));
        if svc::check_health(&public_url).await {
            healthy = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }

    if !healthy {
        let _ = app.emit("agent-status", "error");
        return Err(format!("Agent deployed but not responding at {}. It may still be starting — try connecting manually.", public_url));
    }

    // Step 6: Update state
    *state.agent_url.lock().unwrap() = Some(public_url.clone());
    let info = DeploymentInfo {
        mode: AgentMode::Deployed,
        sandbox_id: Some(deploy_name.clone()),
        public_url: Some(public_url.clone()),
    };
    state.apply_deployment(&info);
    state.save_deployment_info(&info).map_err(|e| format!("Failed to save deployment info: {}", e))?;

    let _ = app.emit("agent-status", "running");
    logging::info("=== deploy_agent: complete ===");
    Ok(public_url)
}

/// Connect to an existing deployed sandbox by URL (for second devices).
#[tauri::command]
pub async fn connect_remote(
    url: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    logging::info(&format!("connect_remote: url={}", url));

    // Normalize URL — strip trailing slash
    let url = url.trim_end_matches('/').to_string();

    // Health check
    if !svc::check_health(&url).await {
        return Err(format!("Agent not responding at {}. Check the URL and try again.", url));
    }

    // Update state
    *state.agent_url.lock().unwrap() = Some(url.clone());
    let info = DeploymentInfo {
        mode: AgentMode::Remote,
        sandbox_id: None,
        public_url: Some(url.clone()),
    };
    state.apply_deployment(&info);
    state.save_deployment_info(&info).map_err(|e| format!("Failed to save deployment info: {}", e))?;

    let _ = app.emit("agent-status", "running");
    logging::info(&format!("connect_remote: connected to {}", url));
    Ok(format!("Connected to {}", url))
}

/// Disconnect from a remote deployment (does not destroy the sandbox).
#[tauri::command]
pub async fn disconnect_remote(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    logging::info("disconnect_remote: disconnecting");

    *state.agent_url.lock().unwrap() = None;
    state.clear_deployment();

    let _ = app.emit("agent-status", "disconnected");
    logging::info("disconnect_remote: done");
    Ok(())
}

/// Tear down a deployed cloud sandbox.
#[tauri::command]
pub async fn teardown_deploy(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    logging::info("teardown_deploy: starting");

    let config = read_config(&state);
    let _cloud_url = if config.heyo_cloud_url.is_empty() {
        "https://server.heyo.computer".to_string()
    } else {
        config.heyo_cloud_url.clone()
    };

    let sandbox_id = state.deploy_sandbox_id.lock().unwrap().clone();

    if let Some(id) = sandbox_id {
        logging::info(&format!("teardown_deploy: stopping sandbox {}", id));
        match heyvm::stop_sandbox(&id) {
            Ok(out) => logging::info(&format!("teardown_deploy: stop output: {}", out.trim())),
            Err(e) => logging::warn(&format!("teardown_deploy: stop error: {}", e)),
        }
    }

    *state.agent_url.lock().unwrap() = None;
    state.clear_deployment();

    let _ = app.emit("agent-status", "disconnected");
    logging::info("teardown_deploy: done");
    Ok(())
}

/// Return current deployment info to the frontend.
#[tauri::command]
pub fn get_deployment_info(
    state: State<'_, AppState>,
) -> DeploymentInfo {
    let mode = state.agent_mode.lock().unwrap().clone();
    let sandbox_id = state.deploy_sandbox_id.lock().unwrap().clone();
    let public_url = state.deploy_url.lock().unwrap().clone();
    DeploymentInfo {
        mode,
        sandbox_id,
        public_url,
    }
}

/// Parse a hostname from the `heyvm bind` output.
/// Falls back to `{name}.heyo.computer` if parsing fails.
fn parse_bind_hostname(output: &str, name: &str) -> String {
    // Look for a line containing a hostname-like pattern (e.g., "slug.heyo.computer")
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.contains(".heyo.computer") {
            // Extract the hostname — it may be the whole line or part of it
            for word in trimmed.split_whitespace() {
                if word.contains(".heyo.computer") {
                    return word.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string();
                }
            }
        }
    }
    // Fallback: use the sandbox name as slug
    format!("{}.heyo.computer", name)
}
