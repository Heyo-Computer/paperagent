use tauri::State;
use crate::state::AppState;

fn default_data_dir() -> String {
    dirs::home_dir()
        .map(|h| h.join(".todo").to_string_lossy().to_string())
        .unwrap_or_else(|| "~/.todo".to_string())
}
fn default_cloud_url() -> String {
    "https://server.heyo.computer".to_string()
}
fn default_region() -> String {
    "US".to_string()
}
fn default_size_class() -> String {
    "small".to_string()
}
fn default_image() -> String {
    "ubuntu:24.04".to_string()
}
fn default_spec_verbosity() -> String {
    "normal".to_string()
}
fn default_theme_name() -> String {
    "dark".to_string()
}
fn default_llm_provider() -> String {
    "anthropic".to_string()
}
fn default_openrouter_model() -> String {
    "anthropic/claude-sonnet-4-6".to_string()
}

const USER_CONTEXT_MAX: usize = 1000;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct AgentConfig {
    pub api_key: String,
    pub model: String,
    pub vm_name: String,
    pub vm_backend: String,
    #[serde(default = "default_data_dir")]
    pub data_dir: String,
    #[serde(default)]
    pub heyo_api_key: String,
    #[serde(default = "default_cloud_url")]
    pub heyo_cloud_url: String,
    #[serde(default = "default_region")]
    pub deploy_region: String,
    #[serde(default = "default_size_class")]
    pub deploy_size_class: String,
    #[serde(default = "default_image")]
    pub deploy_image: String,
    #[serde(default)]
    pub speech_api_key: String,
    #[serde(default = "default_spec_verbosity")]
    pub spec_verbosity: String,
    #[serde(default)]
    pub user_context: String,
    #[serde(default = "default_theme_name")]
    pub theme_name: String,
    #[serde(default = "default_llm_provider")]
    pub llm_provider: String,
    #[serde(default)]
    pub openrouter_api_key: String,
    #[serde(default = "default_openrouter_model")]
    pub openrouter_model: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        let backend = if cfg!(target_os = "macos") {
            "apple_vf"
        } else {
            "libvirt"
        };

        Self {
            api_key: String::new(),
            model: "claude-sonnet-4-6".to_string(),
            vm_name: "todo-agent".to_string(),
            vm_backend: backend.to_string(),
            data_dir: default_data_dir(),
            heyo_api_key: String::new(),
            heyo_cloud_url: default_cloud_url(),
            deploy_region: default_region(),
            deploy_size_class: default_size_class(),
            deploy_image: default_image(),
            speech_api_key: String::new(),
            spec_verbosity: default_spec_verbosity(),
            user_context: String::new(),
            theme_name: default_theme_name(),
            llm_provider: default_llm_provider(),
            openrouter_api_key: String::new(),
            openrouter_model: default_openrouter_model(),
        }
    }
}

impl AgentConfig {
    pub fn default_from_disk(config_dir: &std::path::Path) -> Self {
        let path = config_dir.join("agent.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<AgentConfig>(&content) {
                return config;
            }
        }
        AgentConfig::default()
    }
}

#[tauri::command]
pub fn get_agent_config(state: State<AppState>) -> AgentConfig {
    let path = state.config_dir.join("agent.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<AgentConfig>(&content) {
            return config;
        }
    }
    AgentConfig::default()
}

#[tauri::command]
pub fn set_agent_config(mut config: AgentConfig, state: State<AppState>) -> Result<(), String> {
    // Validate spec_verbosity
    if !["terse", "normal", "detailed"].contains(&config.spec_verbosity.as_str()) {
        config.spec_verbosity = "normal".to_string();
    }
    // Cap user_context length
    if config.user_context.chars().count() > USER_CONTEXT_MAX {
        let truncated: String = config.user_context.chars().take(USER_CONTEXT_MAX).collect();
        config.user_context = truncated;
    }

    let _ = std::fs::create_dir_all(&state.config_dir);
    let path = state.config_dir.join("agent.json");
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

// ── Status info returned to the frontend ──

#[derive(serde::Serialize)]
pub struct StatusInfo {
    pub agent_status: String,
    pub sandbox_status: String,
    pub sandbox_name: String,
    pub data_dir: String,
    pub data_dir_exists: bool,
    pub heyvm_available: bool,
    pub agent_error: Option<String>,
    pub sandbox_error: Option<String>,
    pub log_file: String,
    pub agent_mode: String,
    pub deploy_url: Option<String>,
}

#[tauri::command]
pub async fn get_status_info(state: State<'_, AppState>) -> Result<StatusInfo, String> {
    let config = get_agent_config(state.clone());
    let vm_name = config.vm_name.clone();

    let data_path = std::path::Path::new(&config.data_dir);
    let data_dir_exists = data_path.exists();

    // Check if heyvm is on PATH
    let heyvm_available = std::process::Command::new("heyvm")
        .arg("--help")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok();

    // Check sandbox status
    let (sandbox_status, sandbox_error) = if !heyvm_available {
        ("unavailable".to_string(), Some("heyvm not found on PATH".to_string()))
    } else {
        match crate::services::heyvm::sandbox_status(&vm_name) {
            Some(status) => (status, None),
            None => ("not_created".to_string(), None),
        }
    };

    // Check agent health
    let (agent_status, agent_error) = {
        let active_url = state.agent_url.lock().unwrap().clone();
        match active_url {
            Some(url) => {
                if crate::services::agent::check_health(&url).await {
                    ("running".to_string(), None)
                } else {
                    ("unreachable".to_string(), Some(format!("Agent not responding at {}", url)))
                }
            }
            None => ("disconnected".to_string(), None),
        }
    };

    let log_file = crate::logging::log_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let agent_mode = {
        let mode = state.agent_mode.lock().unwrap().clone();
        match mode {
            crate::state::AgentMode::Local => "local",
            crate::state::AgentMode::Deployed => "deployed",
            crate::state::AgentMode::Remote => "remote",
        }.to_string()
    };
    let deploy_url = state.deploy_url.lock().unwrap().clone();

    Ok(StatusInfo {
        agent_status,
        sandbox_status,
        sandbox_name: vm_name,
        data_dir: config.data_dir,
        data_dir_exists,
        heyvm_available,
        agent_error,
        sandbox_error,
        log_file,
        agent_mode,
        deploy_url,
    })
}

#[tauri::command]
pub fn get_recent_logs(lines: Option<usize>) -> String {
    let n = lines.unwrap_or(40);
    let path = match crate::logging::log_path() {
        Some(p) => p,
        None => return String::new(),
    };
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let all: Vec<&str> = content.lines().collect();
    let start = if all.len() > n { all.len() - n } else { 0 };
    all[start..].join("\n")
}
