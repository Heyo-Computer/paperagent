use tauri::State;
use crate::models::todo::{Backlog, DayEntry, TodoItem};
use crate::services::routing::{agent_rpc, require_agent};
use crate::state::AppState;

#[tauri::command]
pub async fn load_day(date: String, state: State<'_, AppState>) -> Result<DayEntry, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/load_day", serde_json::json!({ "date": date })).await
}

#[tauri::command]
pub async fn get_days_range(state: State<'_, AppState>) -> Result<Vec<DayEntry>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/load_days_range", serde_json::json!({ "offset_start": -6, "offset_end": 1 })).await
}

#[tauri::command]
pub async fn get_month_range(state: State<'_, AppState>) -> Result<Vec<DayEntry>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/load_days_range", serde_json::json!({ "offset_start": 2, "offset_end": 28 })).await
}

/// Load an arbitrary day range, given as day offsets relative to today.
/// Backs the Week/Month view navigation (prev/next).
#[tauri::command]
pub async fn get_days_range_offset(offset_start: i64, offset_end: i64, state: State<'_, AppState>) -> Result<Vec<DayEntry>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/load_days_range", serde_json::json!({ "offset_start": offset_start, "offset_end": offset_end })).await
}

#[tauri::command]
pub async fn save_todo(date: String, title: String, state: State<'_, AppState>) -> Result<DayEntry, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/add_todo", serde_json::json!({ "date": date, "title": title })).await
}

#[tauri::command]
pub async fn update_todo(date: String, todo: TodoItem, state: State<'_, AppState>) -> Result<DayEntry, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/update_todo", serde_json::json!({ "date": date, "todo": todo })).await
}

#[tauri::command]
pub async fn delete_todo(date: String, todo_id: String, state: State<'_, AppState>) -> Result<DayEntry, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/delete_todo", serde_json::json!({ "date": date, "todo_id": todo_id })).await
}

#[tauri::command]
pub async fn load_spec(date: String, todo_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/load_spec", serde_json::json!({ "date": date, "todo_id": todo_id })).await
}

#[tauri::command]
pub async fn save_spec(date: String, todo_id: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value = agent_rpc(&url, "storage/save_spec", serde_json::json!({
        "date": date,
        "todo_id": todo_id,
        "content": content,
    })).await?;
    Ok(())
}

// ── Backlog (undated) ──

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct MoveBacklogResult {
    pub backlog: Backlog,
    pub day: DayEntry,
}

#[tauri::command]
pub async fn load_backlog(state: State<'_, AppState>) -> Result<Backlog, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/load_backlog", serde_json::json!({})).await
}

#[tauri::command]
pub async fn add_backlog_item(title: String, state: State<'_, AppState>) -> Result<Backlog, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/add_backlog_item", serde_json::json!({ "title": title })).await
}

#[tauri::command]
pub async fn update_backlog_item(item: TodoItem, state: State<'_, AppState>) -> Result<Backlog, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/update_backlog_item", serde_json::json!({ "item": item })).await
}

#[tauri::command]
pub async fn delete_backlog_item(item_id: String, state: State<'_, AppState>) -> Result<Backlog, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/delete_backlog_item", serde_json::json!({ "item_id": item_id })).await
}

#[tauri::command]
pub async fn load_backlog_spec(item_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/load_backlog_spec", serde_json::json!({ "item_id": item_id })).await
}

#[tauri::command]
pub async fn save_backlog_spec(item_id: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value = agent_rpc(&url, "storage/save_backlog_spec", serde_json::json!({
        "item_id": item_id,
        "content": content,
    })).await?;
    Ok(())
}

#[tauri::command]
pub async fn move_backlog_to_day(item_id: String, date: String, state: State<'_, AppState>) -> Result<MoveBacklogResult, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "storage/move_backlog_to_day", serde_json::json!({ "item_id": item_id, "date": date })).await
}
