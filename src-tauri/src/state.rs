use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Local,
    Deployed,
    Remote,
    /// Connected to a sandbox shared over P2P (iroh) via a heyo:// ticket.
    P2p,
}

impl Default for AgentMode {
    fn default() -> Self {
        AgentMode::Local
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DeploymentInfo {
    pub mode: AgentMode,
    pub sandbox_id: Option<String>,
    pub public_url: Option<String>,
    /// P2P: the heyo:// ticket or relay shortname used to connect. Persisted so
    /// the tunnel can be re-established on the next launch.
    #[serde(default)]
    pub p2p_ticket: Option<String>,
    /// P2P: optional iroh relay override passed alongside the ticket.
    #[serde(default)]
    pub p2p_relay: Option<String>,
}

impl Default for DeploymentInfo {
    fn default() -> Self {
        Self {
            mode: AgentMode::Local,
            sandbox_id: None,
            public_url: None,
            p2p_ticket: None,
            p2p_relay: None,
        }
    }
}

pub struct AppState {
    pub storage_root: PathBuf,
    pub config_dir: PathBuf,
    pub artifacts_dir: PathBuf,
    pub data_dir: PathBuf,
    pub vm_name: Mutex<Option<String>>,
    /// Actual agent URL (e.g. "http://localhost:8080") when connected.
    pub agent_url: Mutex<Option<String>>,
    /// Running `heyvm port-forward` child process (fallback for old sandboxes without --open-port).
    pub port_forward_child: Mutex<Option<std::process::Child>>,
    /// Current agent connection mode.
    pub agent_mode: Mutex<AgentMode>,
    /// Cloud sandbox ID/slug after deploy.
    pub deploy_sandbox_id: Mutex<Option<String>>,
    /// Public URL after bind (e.g. "https://slug.heyo.computer"). For P2P this
    /// holds the local tunnel URL (e.g. "http://127.0.0.1:54321").
    pub deploy_url: Mutex<Option<String>>,
    /// P2P: the ticket/shortname of the current connection (mirror of DeploymentInfo).
    pub p2p_ticket: Mutex<Option<String>>,
    /// P2P: the relay override for the current connection (mirror of DeploymentInfo).
    pub p2p_relay: Mutex<Option<String>>,
    /// P2P: the live iroh tunnel. Dropping it tears the tunnel down.
    pub p2p_tunnel: Mutex<Option<heyo_sdk::P2pTunnel>>,
    /// Cancellation token for the running connection supervisor (Deployed/P2P).
    pub supervisor: Mutex<Option<tokio_util::sync::CancellationToken>>,
}

impl AppState {
    pub fn new() -> Self {
        let home = dirs::home_dir().expect("Could not determine home directory");
        let base = home.join(".todo");

        Self {
            storage_root: base.join("storage"),
            config_dir: base.join("config"),
            artifacts_dir: base.join("artifacts"),
            data_dir: base.clone(),
            vm_name: Mutex::new(None),
            agent_url: Mutex::new(None),
            port_forward_child: Mutex::new(None),
            agent_mode: Mutex::new(AgentMode::Local),
            deploy_sandbox_id: Mutex::new(None),
            deploy_url: Mutex::new(None),
            p2p_ticket: Mutex::new(None),
            p2p_relay: Mutex::new(None),
            p2p_tunnel: Mutex::new(None),
            supervisor: Mutex::new(None),
        }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.storage_root)?;
        std::fs::create_dir_all(&self.config_dir)?;
        std::fs::create_dir_all(&self.artifacts_dir)?;
        Ok(())
    }

    pub fn kill_port_forward(&self) {
        if let Some(mut child) = self.port_forward_child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Tear down the live P2P tunnel (if any). Dropping the `P2pTunnel` aborts
    /// its background forwarding task and closes the local listener.
    pub fn drop_p2p_tunnel(&self) {
        let _ = self.p2p_tunnel.lock().unwrap().take();
    }

    /// Stop the connection supervisor (if running). The supervisor loop observes
    /// the cancellation token and exits on its own; we never await it here.
    pub fn stop_supervisor(&self) {
        if let Some(token) = self.supervisor.lock().unwrap().take() {
            token.cancel();
        }
    }

    /// Load persisted deployment info from disk.
    pub fn load_deployment_info(&self) -> DeploymentInfo {
        let path = self.config_dir.join("deployment.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(info) = serde_json::from_str::<DeploymentInfo>(&content) {
                return info;
            }
        }
        DeploymentInfo::default()
    }

    /// Save deployment info to disk.
    pub fn save_deployment_info(&self, info: &DeploymentInfo) -> Result<(), String> {
        let path = self.config_dir.join("deployment.json");
        let content = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
        std::fs::write(&path, content).map_err(|e| e.to_string())
    }

    /// Apply deployment info to in-memory state.
    pub fn apply_deployment(&self, info: &DeploymentInfo) {
        *self.agent_mode.lock().unwrap() = info.mode.clone();
        *self.deploy_sandbox_id.lock().unwrap() = info.sandbox_id.clone();
        *self.deploy_url.lock().unwrap() = info.public_url.clone();
        *self.p2p_ticket.lock().unwrap() = info.p2p_ticket.clone();
        *self.p2p_relay.lock().unwrap() = info.p2p_relay.clone();
    }

    /// Clear all deployment state and persist.
    pub fn clear_deployment(&self) {
        let info = DeploymentInfo::default();
        self.apply_deployment(&info);
        let _ = self.save_deployment_info(&info);
    }
}
