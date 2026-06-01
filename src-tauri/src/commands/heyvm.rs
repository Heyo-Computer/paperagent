use tauri::State;
use crate::services::heyvm as svc;
use crate::state::AppState;

fn vm_name_from_config(state: &AppState) -> String {
    let path = state.config_dir.join("agent.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<crate::commands::config::AgentConfig>(&content) {
            if !config.vm_name.is_empty() {
                return config.vm_name;
            }
        }
    }
    "todo-agent".to_string()
}

fn vm_backend_from_config(state: &AppState) -> String {
    let path = state.config_dir.join("agent.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<crate::commands::config::AgentConfig>(&content) {
            if !config.vm_backend.is_empty() {
                return config.vm_backend;
            }
        }
    }
    if cfg!(target_os = "macos") { "apple_vf" } else { "libvirt" }.to_string()
}

fn data_dir_from_config(state: &AppState) -> String {
    let path = state.config_dir.join("agent.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(config) = serde_json::from_str::<crate::commands::config::AgentConfig>(&content) {
            if !config.data_dir.is_empty() {
                return config.data_dir;
            }
        }
    }
    state.data_dir.to_string_lossy().to_string()
}

#[tauri::command]
pub fn create_vm(state: State<AppState>) -> Result<String, String> {
    let name = vm_name_from_config(&state);
    let backend = vm_backend_from_config(&state);
    let data = data_dir_from_config(&state);

    // Ensure the data dir exists
    let data_path = std::path::Path::new(&data);
    std::fs::create_dir_all(data_path).map_err(|e| format!("Failed to create data dir: {}", e))?;

    if svc::sandbox_exists(&name) {
        *state.vm_name.lock().unwrap() = Some(name.clone());
        return Ok(format!("Sandbox '{}' already exists", name));
    }

    let result = svc::create_sandbox_with_backend(&name, &backend, &data, None, &[])?;
    *state.vm_name.lock().unwrap() = Some(name.clone());
    Ok(result.name)
}

#[tauri::command]
pub fn snapshot_vm(snapshot_name: String, state: State<AppState>) -> Result<svc::SnapshotResult, String> {
    let name = vm_name_from_config(&state);
    svc::snapshot(&name, &snapshot_name)
}

#[tauri::command]
pub fn start_vm(state: State<AppState>) -> Result<bool, String> {
    let name = vm_name_from_config(&state);
    svc::start_sandbox(&name)?;
    *state.vm_name.lock().unwrap() = Some(name);
    Ok(true)
}

#[tauri::command]
pub fn stop_vm(state: State<AppState>) -> Result<bool, String> {
    let name = vm_name_from_config(&state);
    svc::stop_sandbox(&name)?;
    *state.vm_name.lock().unwrap() = None;
    Ok(true)
}

#[tauri::command]
pub fn vm_status(state: State<AppState>) -> String {
    let name = vm_name_from_config(&state);
    if svc::sandbox_exists(&name) {
        "running".to_string()
    } else {
        "stopped".to_string()
    }
}

#[tauri::command]
pub fn list_sandboxes() -> Result<Vec<String>, String> {
    svc::list_sandbox_names()
}

#[derive(serde::Serialize)]
pub struct VmInfo {
    pub name: String,
    pub status: String,
    pub backend: String,
}

/// List all sandboxes (running + stopped) with status — powers the "use existing
/// VM" picker for the sync-to-another-workstation flow.
#[tauri::command]
pub fn list_vms() -> Result<Vec<VmInfo>, String> {
    let output = svc::list_all_sandboxes()?;
    let mut vms = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        if cols.len() < 3 || cols[0] == "NAME" {
            continue;
        }
        vms.push(VmInfo {
            name: cols[0].to_string(),
            status: cols[2].to_string(),
            backend: cols.get(3).map(|s| s.to_string()).unwrap_or_default(),
        });
    }
    Ok(vms)
}
