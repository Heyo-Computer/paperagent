use tauri::State;
use serde_json::{Map, Value};
use crate::models::list::{List, ListField, ListItem, ListSummary};
use crate::services::routing::{agent_rpc, require_agent};
use crate::state::AppState;

#[tauri::command]
pub async fn list_lists(state: State<'_, AppState>) -> Result<Vec<ListSummary>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "lists/list_lists", serde_json::json!({})).await
}

#[tauri::command]
pub async fn load_list(list_id: String, state: State<'_, AppState>) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "lists/load_list", serde_json::json!({ "list_id": list_id })).await
}

#[tauri::command]
pub async fn create_list(name: String, fields: Vec<ListField>, state: State<'_, AppState>) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "lists/create_list", serde_json::json!({ "name": name, "fields": fields })).await
}

#[tauri::command]
pub async fn update_list_meta(list_id: String, name: String, fields: Vec<ListField>, state: State<'_, AppState>) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "lists/update_list_meta", serde_json::json!({ "list_id": list_id, "name": name, "fields": fields })).await
}

#[tauri::command]
pub async fn delete_list(list_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value = agent_rpc(&url, "lists/delete_list", serde_json::json!({ "list_id": list_id })).await?;
    Ok(())
}

#[tauri::command]
pub async fn add_list_item(list_id: String, values: Map<String, Value>, state: State<'_, AppState>) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "lists/add_list_item", serde_json::json!({ "list_id": list_id, "values": values })).await
}

#[tauri::command]
pub async fn update_list_item(list_id: String, item: ListItem, state: State<'_, AppState>) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "lists/update_list_item", serde_json::json!({ "list_id": list_id, "item": item })).await
}

#[tauri::command]
pub async fn delete_list_item(list_id: String, item_id: String, state: State<'_, AppState>) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "lists/delete_list_item", serde_json::json!({ "list_id": list_id, "item_id": item_id })).await
}
