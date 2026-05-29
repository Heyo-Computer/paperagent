use tauri::State;
use serde_json::{Map, Value};
use crate::models::list::{List, ListField, ListItem, ListSummary};
use crate::services::storage as svc;
use crate::services::agent as agent_svc;
use crate::state::AppState;

fn agent_url(state: &AppState) -> Option<String> {
    state.agent_url.lock().unwrap().clone()
}

async fn agent_rpc<T: serde::de::DeserializeOwned>(
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<T, String> {
    let resp = agent_svc::send_rpc(url, method, params).await?;
    if let Some(err) = resp.error {
        return Err(err.message);
    }
    let result = resp.result.ok_or("Empty response from agent")?;
    serde_json::from_value(result).map_err(|e| format!("Failed to parse: {}", e))
}

#[tauri::command]
pub async fn list_lists(state: State<'_, AppState>) -> Result<Vec<ListSummary>, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "lists/list_lists", serde_json::json!({})).await;
    }
    Ok(svc::list_lists(&state.storage_root))
}

#[tauri::command]
pub async fn load_list(list_id: String, state: State<'_, AppState>) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "lists/load_list", serde_json::json!({ "list_id": list_id })).await;
    }
    svc::get_list(&state.storage_root, &list_id)
}

#[tauri::command]
pub async fn create_list(name: String, fields: Vec<ListField>, state: State<'_, AppState>) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "lists/create_list", serde_json::json!({ "name": name, "fields": fields })).await;
    }
    svc::create_list(&state.storage_root, &name, fields)
}

#[tauri::command]
pub async fn update_list_meta(list_id: String, name: String, fields: Vec<ListField>, state: State<'_, AppState>) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "lists/update_list_meta", serde_json::json!({ "list_id": list_id, "name": name, "fields": fields })).await;
    }
    svc::update_list_meta(&state.storage_root, &list_id, &name, fields)
}

#[tauri::command]
pub async fn delete_list(list_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(url) = agent_url(&state) {
        let _: serde_json::Value = agent_rpc(&url, "lists/delete_list", serde_json::json!({ "list_id": list_id })).await?;
        return Ok(());
    }
    svc::delete_list(&state.storage_root, &list_id)
}

#[tauri::command]
pub async fn add_list_item(list_id: String, values: Map<String, Value>, state: State<'_, AppState>) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "lists/add_list_item", serde_json::json!({ "list_id": list_id, "values": values })).await;
    }
    svc::add_list_item(&state.storage_root, &list_id, values)
}

#[tauri::command]
pub async fn update_list_item(list_id: String, item: ListItem, state: State<'_, AppState>) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "lists/update_list_item", serde_json::json!({ "list_id": list_id, "item": item })).await;
    }
    svc::update_list_item(&state.storage_root, &list_id, item)
}

#[tauri::command]
pub async fn delete_list_item(list_id: String, item_id: String, state: State<'_, AppState>) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "lists/delete_list_item", serde_json::json!({ "list_id": list_id, "item_id": item_id })).await;
    }
    svc::delete_list_item(&state.storage_root, &list_id, &item_id)
}
