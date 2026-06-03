use tauri::State;
use crate::models::artifact::Artifact;
use crate::services::routing::{agent_rpc, require_agent};
use crate::state::AppState;

#[tauri::command]
pub async fn list_artifacts(dir: Option<String>, state: State<'_, AppState>) -> Result<Vec<Artifact>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/list", serde_json::json!({ "dir": dir.unwrap_or_default() })).await
}

#[tauri::command]
pub async fn list_all_artifacts(state: State<'_, AppState>) -> Result<Vec<Artifact>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/list_all", serde_json::json!({})).await
}

#[tauri::command]
pub async fn read_artifact(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/read", serde_json::json!({ "path": path })).await
}

#[tauri::command]
pub async fn save_artifact(path: String, content: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/save", serde_json::json!({ "path": path, "content": content })).await
}

#[tauri::command]
pub async fn delete_artifact(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value = agent_rpc(&url, "artifacts/delete", serde_json::json!({ "path": path })).await?;
    Ok(())
}

#[tauri::command]
pub async fn create_artifact_folder(path: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/create_folder", serde_json::json!({ "path": path })).await
}

#[tauri::command]
pub async fn rename_artifact(path: String, new_name: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/rename", serde_json::json!({ "path": path, "new_name": new_name })).await
}

#[tauri::command]
pub async fn move_artifact(path: String, target_dir: String, state: State<'_, AppState>) -> Result<Artifact, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/move", serde_json::json!({ "path": path, "target_dir": target_dir })).await
}

#[tauri::command]
pub async fn list_artifact_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "artifacts/list_folders", serde_json::json!({})).await
}
