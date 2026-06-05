//! P2P (iroh) connection target + the connection-maintenance supervisor.
//!
//! P2P connects to a sandbox someone else shared over iroh (`heyvm proxy start`
//! / `heyvm share`) via a `heyo://` ticket or relay shortname. The tunnel is
//! established **in-process** through the heyvm Rust SDK (`heyo_sdk::P2pTunnel`)
//! — no child process, no output parsing; the local port is known immediately
//! and the tunnel tears down cleanly when dropped.
//!
//! Network connects to a VM the user exposed on their heyo network: the app
//! resolves a service `name:port` to a live `heyo://` ticket via the cloud
//! (`heyo_sdk::Network::dial_service`, authed with the configured Heyo API key)
//! and tunnels to it the same way as P2P. The service — not the ticket — is
//! persisted, so reconnects re-dial for a fresh route (network tickets rotate).
//!
//! For Deployed, P2P, and Network targets a background supervisor keeps the
//! connection warm (periodic `/health` pings over the pooled HTTP client) and
//! auto-reconnects on drop: re-establishing the iroh tunnel for P2P, re-dialing
//! the service for Network, retrying the stable public URL for Deployed. Local
//! mode is unmanaged (it has its own sandbox lifecycle).

use tauri::{AppHandle, Emitter, Manager, State};

use crate::logging;
use crate::services::agent as svc;
use crate::state::{AgentMode, AppState, DeploymentInfo};

/// How often the supervisor pings the agent to keep the path warm / detect drops.
const HEARTBEAT_SECS: u64 = 15;
/// How many 1s health attempts to allow while a P2P tunnel comes up (iroh
/// handshake + agent readiness).
const P2P_HEALTH_ATTEMPTS: u32 = 20;

fn progress(app: &AppHandle, msg: &str) {
    logging::info(&format!("p2p: {}", msg));
    let _ = app.emit("deploy-progress", msg.to_string());
}

/// Establish (or re-establish) the P2P tunnel from a ticket: drop any prior
/// tunnel, connect over iroh, store the live tunnel in state, then poll the
/// agent's health until it answers. Returns the local tunnel URL on success and
/// leaves no tunnel stored on failure.
///
/// Takes `&AppHandle` (not a held `State` guard) and re-acquires state only for
/// momentary, synchronous operations — never across an `.await` — so the future
/// stays `Send` and no lock is held across suspension.
async fn establish_p2p(
    app: &AppHandle,
    ticket: &str,
    relay: Option<&str>,
) -> Result<String, String> {
    app.state::<AppState>().drop_p2p_tunnel();

    let tunnel = heyo_sdk::P2pTunnel::connect(ticket, relay)
        .await
        .map_err(|e| format!("P2P connect failed: {}", e))?;
    let url = tunnel.local_url();
    logging::info(&format!("establish_p2p: tunnel listening at {}", url));
    *app.state::<AppState>().p2p_tunnel.lock().unwrap() = Some(tunnel);

    for attempt in 1..=P2P_HEALTH_ATTEMPTS {
        if svc::check_health(&url).await {
            logging::info(&format!(
                "establish_p2p: agent healthy at {} (attempt {})",
                url, attempt
            ));
            return Ok(url);
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }

    app.state::<AppState>().drop_p2p_tunnel();
    Err(format!("Tunnel connected but agent did not respond at {}", url))
}

/// Connect to a sandbox shared over P2P. Establishes the tunnel, points the
/// agent at it, persists the target, and starts the connection supervisor.
#[tauri::command]
pub async fn connect_p2p(
    ticket: String,
    relay: Option<String>,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let ticket = ticket.trim().to_string();
    if ticket.is_empty() {
        return Err("A heyo:// ticket or shortname is required.".to_string());
    }
    let relay = relay.and_then(|r| {
        let r = r.trim().to_string();
        if r.is_empty() {
            None
        } else {
            Some(r)
        }
    });
    logging::info(&format!("connect_p2p: ticket={}, relay={:?}", ticket, relay));
    let _ = app.emit("agent-status", "starting");

    // Tear down any prior supervisor/tunnel before opening a new connection.
    state.stop_supervisor();

    progress(&app, "Connecting over P2P...");
    let url = match establish_p2p(&app, &ticket, relay.as_deref()).await {
        Ok(url) => url,
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            return Err(e);
        }
    };

    *state.agent_url.lock().unwrap() = Some(url.clone());
    let info = DeploymentInfo {
        mode: AgentMode::P2p,
        sandbox_id: None,
        public_url: Some(url),
        p2p_ticket: Some(ticket.clone()),
        p2p_relay: relay,
        network_service: None,
        network_port: None,
    };
    state.apply_deployment(&info);
    state
        .save_deployment_info(&info)
        .map_err(|e| format!("Failed to save deployment info: {}", e))?;

    spawn_supervisor(&app);
    let _ = app.emit("agent-status", "running");
    logging::info(&format!("connect_p2p: connected via {}", ticket));
    Ok(format!("Connected to {}", ticket))
}

/// Disconnect from a P2P sandbox: stop the supervisor, drop the tunnel, and
/// reset to local. Does not affect the remote sandbox (it's someone else's).
#[tauri::command]
pub async fn disconnect_p2p(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    logging::info("disconnect_p2p: disconnecting");
    state.stop_supervisor();
    state.drop_p2p_tunnel();
    *state.agent_url.lock().unwrap() = None;
    state.clear_deployment();
    let _ = app.emit("agent-status", "disconnected");
    Ok(())
}

/// On launch, reconnect to a persisted Deployed / P2P / Remote target. Returns
/// `true` if a non-local target was handled (the caller should then skip the
/// local-sandbox auto-start). P2P re-establishes the iroh tunnel from the saved
/// ticket; Deployed health-checks the stable public URL and starts a supervisor;
/// Remote health-checks only (stays passive — a user-supplied URL we don't manage).
pub async fn resume_persisted(app: &AppHandle) -> bool {
    let info = app.state::<AppState>().load_deployment_info();
    match info.mode {
        AgentMode::Local => false,
        AgentMode::P2p => {
            app.state::<AppState>().apply_deployment(&info);
            let _ = app.emit("agent-status", "starting");
            let Some(ticket) = info.p2p_ticket.clone() else {
                logging::warn("resume_persisted: p2p target missing ticket");
                let _ = app.emit("agent-status", "error");
                return true;
            };
            logging::info(&format!("resume_persisted: reconnecting P2P via {}", ticket));
            match establish_p2p(app, &ticket, info.p2p_relay.as_deref()).await {
                Ok(url) => {
                    let state = app.state::<AppState>();
                    *state.agent_url.lock().unwrap() = Some(url.clone());
                    *state.deploy_url.lock().unwrap() = Some(url.clone());
                    // The local port changed; persist the refreshed URL.
                    let refreshed = DeploymentInfo {
                        mode: AgentMode::P2p,
                        sandbox_id: None,
                        public_url: Some(url),
                        p2p_ticket: Some(ticket),
                        p2p_relay: info.p2p_relay.clone(),
                        network_service: None,
                        network_port: None,
                    };
                    let _ = state.save_deployment_info(&refreshed);
                    spawn_supervisor(app);
                    let _ = app.emit("agent-status", "running");
                }
                Err(e) => {
                    logging::warn(&format!("resume_persisted: P2P reconnect failed: {}", e));
                    let _ = app.emit("agent-status", "error");
                }
            }
            true
        }
        AgentMode::Network => {
            app.state::<AppState>().apply_deployment(&info);
            let _ = app.emit("agent-status", "starting");
            let (Some(name), Some(port)) = (info.network_service.clone(), info.network_port) else {
                logging::warn("resume_persisted: network target missing service");
                let _ = app.emit("agent-status", "error");
                return true;
            };
            logging::info(&format!("resume_persisted: reconnecting network service {}:{}", name, port));
            match dial_network_ticket(app, &name, port).await {
                Ok(ticket) => match establish_p2p(app, &ticket, None).await {
                    Ok(url) => {
                        let state = app.state::<AppState>();
                        *state.agent_url.lock().unwrap() = Some(url.clone());
                        *state.deploy_url.lock().unwrap() = Some(url.clone());
                        persist_network(&state, &name, port, url);
                        spawn_supervisor(app);
                        let _ = app.emit("agent-status", "running");
                    }
                    Err(e) => {
                        logging::warn(&format!("resume_persisted: network tunnel failed: {}", e));
                        let _ = app.emit("agent-status", "error");
                    }
                },
                Err(e) => {
                    logging::warn(&format!("resume_persisted: network dial failed: {}", e));
                    let _ = app.emit("agent-status", "error");
                }
            }
            true
        }
        AgentMode::Deployed | AgentMode::Remote => {
            app.state::<AppState>().apply_deployment(&info);
            let _ = app.emit("agent-status", "starting");
            let Some(url) = info.public_url.clone() else {
                logging::warn("resume_persisted: deployed/remote target missing url");
                let _ = app.emit("agent-status", "error");
                return true;
            };
            logging::info(&format!("resume_persisted: reconnecting {:?} at {}", info.mode, url));
            if svc::check_health(&url).await {
                *app.state::<AppState>().agent_url.lock().unwrap() = Some(url);
                // Deployed gets the keep-alive supervisor; Remote stays passive.
                if info.mode == AgentMode::Deployed {
                    spawn_supervisor(app);
                }
                let _ = app.emit("agent-status", "running");
            } else {
                logging::warn("resume_persisted: persisted target not healthy");
                let _ = app.emit("agent-status", "error");
            }
            true
        }
    }
}

/// Start the connection supervisor for the current Deployed/P2P target. Idempotent:
/// any prior supervisor is cancelled first, so at most one runs at a time.
pub fn spawn_supervisor(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.stop_supervisor();

    let cancel = tokio_util::sync::CancellationToken::new();
    *state.supervisor.lock().unwrap() = Some(cancel.clone());

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        supervisor_loop(app, cancel).await;
    });
}

/// Heartbeat loop: every `HEARTBEAT_SECS`, ping the agent; on failure, attempt a
/// mode-appropriate reconnect. Re-reads mode/url fresh each tick and never holds
/// a lock across `.await`.
async fn supervisor_loop(app: AppHandle, cancel: tokio_util::sync::CancellationToken) {
    let interval = std::time::Duration::from_secs(HEARTBEAT_SECS);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = tokio::time::sleep(interval) => {}
        }
        if cancel.is_cancelled() {
            break;
        }

        // Snapshot mode + url without holding any lock across an await.
        let (mode, url) = {
            let state = app.state::<AppState>();
            let mode = state.agent_mode.lock().unwrap().clone();
            let url = state.agent_url.lock().unwrap().clone();
            (mode, url)
        };

        // The supervisor only manages Deployed + P2P + Network. If the mode
        // changed out from under us, stop.
        match mode {
            AgentMode::Deployed | AgentMode::P2p | AgentMode::Network => {}
            _ => break,
        }

        let Some(url) = url else {
            continue;
        };

        if svc::check_health(&url).await {
            continue;
        }

        logging::warn(&format!(
            "supervisor: agent unhealthy at {}, attempting reconnect",
            url
        ));
        let _ = app.emit("agent-status", "reconnecting");

        let recovered = match mode {
            AgentMode::P2p => reconnect_p2p(&app).await,
            AgentMode::Network => reconnect_network(&app).await,
            AgentMode::Deployed => reconnect_deployed(&app).await,
            _ => false,
        };

        let _ = app.emit("agent-status", if recovered { "running" } else { "error" });
    }
    logging::info("supervisor: loop exited");
}

/// Re-establish a dropped P2P tunnel from the saved ticket. The local port
/// changes on each connect, so the refreshed URL is persisted.
async fn reconnect_p2p(app: &AppHandle) -> bool {
    let (ticket, relay) = {
        let state = app.state::<AppState>();
        let ticket = state.p2p_ticket.lock().unwrap().clone();
        let relay = state.p2p_relay.lock().unwrap().clone();
        (ticket, relay)
    };
    let Some(ticket) = ticket else {
        logging::warn("reconnect_p2p: no saved ticket");
        return false;
    };

    match establish_p2p(app, &ticket, relay.as_deref()).await {
        Ok(url) => {
            let state = app.state::<AppState>();
            *state.agent_url.lock().unwrap() = Some(url.clone());
            *state.deploy_url.lock().unwrap() = Some(url.clone());
            let info = DeploymentInfo {
                mode: AgentMode::P2p,
                sandbox_id: None,
                public_url: Some(url),
                p2p_ticket: Some(ticket),
                p2p_relay: relay,
                network_service: None,
                network_port: None,
            };
            let _ = state.save_deployment_info(&info);
            logging::info("reconnect_p2p: tunnel re-established");
            true
        }
        Err(e) => {
            logging::warn(&format!("reconnect_p2p: {}", e));
            false
        }
    }
}

/// Re-confirm a Deployed agent. The public URL is stable (the cloud sandbox and
/// bind persist), so this only retries health with a short backoff to ride out a
/// transient outage.
async fn reconnect_deployed(app: &AppHandle) -> bool {
    let url = { app.state::<AppState>().agent_url.lock().unwrap().clone() };
    let Some(url) = url else {
        return false;
    };
    for attempt in 1..=5u64 {
        tokio::time::sleep(std::time::Duration::from_secs(2 * attempt)).await;
        if svc::check_health(&url).await {
            logging::info("reconnect_deployed: agent recovered");
            return true;
        }
    }
    false
}

// ── Network (heyo cloud service routing) ──

/// Build SDK client options from the configured Heyo API key + cloud URL (the
/// same credentials used for cloud deploy).
fn heyo_client_options(app: &AppHandle) -> Result<heyo_sdk::HeyoClientOptions, String> {
    let state = app.state::<AppState>();
    let config = crate::commands::config::AgentConfig::default_from_disk(&state.config_dir);
    if config.heyo_api_key.trim().is_empty() {
        return Err("Set your Heyo API key in Settings to use networked VMs.".to_string());
    }
    let base_url = if config.heyo_cloud_url.trim().is_empty() {
        None
    } else {
        Some(config.heyo_cloud_url)
    };
    Ok(heyo_sdk::HeyoClientOptions {
        api_key: Some(config.heyo_api_key),
        base_url,
        timeout: None,
    })
}

/// Resolve a network service `name:port` to a live `heyo://` ticket via the cloud.
async fn dial_network_ticket(app: &AppHandle, name: &str, port: u16) -> Result<String, String> {
    let opts = heyo_client_options(app)?;
    let route = heyo_sdk::Network::dial_service(name, port, opts)
        .await
        .map_err(|e| format!("Could not resolve {}:{} on your network: {}", name, port, e))?;
    Ok(route.connection_url)
}

fn network_info(name: &str, port: u16, url: String) -> DeploymentInfo {
    DeploymentInfo {
        mode: AgentMode::Network,
        sandbox_id: None,
        public_url: Some(url),
        p2p_ticket: None,
        p2p_relay: None,
        network_service: Some(name.to_string()),
        network_port: Some(port),
    }
}

/// Persist the network target with a refreshed tunnel URL (mode/service are
/// already applied to in-memory state by the caller).
fn persist_network(state: &AppState, name: &str, port: u16, url: String) {
    let _ = state.save_deployment_info(&network_info(name, port, url));
}

/// A service on the user's default heyo network, for the connect picker.
#[derive(serde::Serialize)]
pub struct NetworkServiceInfo {
    pub name: String,
    pub port: u16,
    pub address: String,
    pub sandbox_kind: String,
    pub status: String,
    /// True when the service has a live iroh route (connectable right now).
    pub routable: bool,
}

/// List services registered on the user's default heyo network so the UI can
/// offer a picker. Uses the configured Heyo API key.
#[tauri::command]
pub async fn list_network_services(app: AppHandle) -> Result<Vec<NetworkServiceInfo>, String> {
    let opts = heyo_client_options(&app)?;
    let services = heyo_sdk::Network::list_services(opts)
        .await
        .map_err(|e| e.to_string())?;
    Ok(services
        .into_iter()
        .map(|s| NetworkServiceInfo {
            routable: s.connection_url.is_some()
                || s.transport.as_deref() == Some("iroh_tcp_proxy"),
            name: s.name,
            port: s.port,
            address: s.address,
            sandbox_kind: s.sandbox_kind,
            status: s.status,
        })
        .collect())
}

/// Connect to a VM exposed on the user's heyo network by service `name:port`.
/// Resolves a live ticket through the cloud, tunnels to it in-process, and
/// persists the service (not the ticket) so reconnects re-dial a fresh route.
#[tauri::command]
pub async fn connect_network(
    name: String,
    port: u16,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("A service name is required.".to_string());
    }
    logging::info(&format!("connect_network: service={}:{}", name, port));
    let _ = app.emit("agent-status", "starting");
    state.stop_supervisor();

    progress(&app, &format!("Resolving {}:{} on your network...", name, port));
    let ticket = match dial_network_ticket(&app, &name, port).await {
        Ok(t) => t,
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            return Err(e);
        }
    };

    progress(&app, "Connecting over the network...");
    let url = match establish_p2p(&app, &ticket, None).await {
        Ok(u) => u,
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            return Err(e);
        }
    };

    *state.agent_url.lock().unwrap() = Some(url.clone());
    let info = network_info(&name, port, url);
    state.apply_deployment(&info);
    state
        .save_deployment_info(&info)
        .map_err(|e| format!("Failed to save deployment info: {}", e))?;

    spawn_supervisor(&app);
    let _ = app.emit("agent-status", "running");
    logging::info(&format!("connect_network: connected to {}:{}", name, port));
    Ok(format!("Connected to {}:{}", name, port))
}

/// Re-dial the network service for a fresh route, then re-establish the tunnel.
async fn reconnect_network(app: &AppHandle) -> bool {
    let (name, port) = {
        let state = app.state::<AppState>();
        let name = state.network_service.lock().unwrap().clone();
        let port = *state.network_port.lock().unwrap();
        (name, port)
    };
    let (Some(name), Some(port)) = (name, port) else {
        logging::warn("reconnect_network: no saved service");
        return false;
    };
    let ticket = match dial_network_ticket(app, &name, port).await {
        Ok(t) => t,
        Err(e) => {
            logging::warn(&format!("reconnect_network: dial failed: {}", e));
            return false;
        }
    };
    match establish_p2p(app, &ticket, None).await {
        Ok(url) => {
            let state = app.state::<AppState>();
            *state.agent_url.lock().unwrap() = Some(url.clone());
            *state.deploy_url.lock().unwrap() = Some(url.clone());
            persist_network(&state, &name, port, url);
            logging::info("reconnect_network: route re-established");
            true
        }
        Err(e) => {
            logging::warn(&format!("reconnect_network: {}", e));
            false
        }
    }
}
