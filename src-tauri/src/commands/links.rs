use tauri::State;
use crate::models::book::Book;
use crate::models::list::List;
use crate::services::agent as agent_svc;
use crate::services::storage as svc;
use crate::services::storage::{ItemFromTodo, PageFromTodo};
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
pub async fn link_todo_to_list_item(
    date: String,
    todo_id: String,
    list_id: String,
    item_id: String,
    state: State<'_, AppState>,
) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(
            &url,
            "links/link_todo_to_list_item",
            serde_json::json!({ "date": date, "todo_id": todo_id, "list_id": list_id, "item_id": item_id }),
        )
        .await;
    }
    svc::link_todo_to_list_item(&state.storage_root, &date, &todo_id, &list_id, &item_id)
}

#[tauri::command]
pub async fn unlink_todo_from_list_item(
    date: String,
    todo_id: String,
    list_id: String,
    item_id: String,
    state: State<'_, AppState>,
) -> Result<List, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(
            &url,
            "links/unlink_todo_from_list_item",
            serde_json::json!({ "date": date, "todo_id": todo_id, "list_id": list_id, "item_id": item_id }),
        )
        .await;
    }
    svc::unlink_todo_from_list_item(&state.storage_root, &date, &todo_id, &list_id, &item_id)
}

#[tauri::command]
pub async fn link_todo_to_book_page(
    date: String,
    todo_id: String,
    book_id: String,
    page_id: String,
    state: State<'_, AppState>,
) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(
            &url,
            "links/link_todo_to_book_page",
            serde_json::json!({ "date": date, "todo_id": todo_id, "book_id": book_id, "page_id": page_id }),
        )
        .await;
    }
    svc::link_todo_to_book_page(&state.storage_root, &date, &todo_id, &book_id, &page_id)
}

#[tauri::command]
pub async fn unlink_todo_from_book_page(
    date: String,
    todo_id: String,
    book_id: String,
    page_id: String,
    state: State<'_, AppState>,
) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(
            &url,
            "links/unlink_todo_from_book_page",
            serde_json::json!({ "date": date, "todo_id": todo_id, "book_id": book_id, "page_id": page_id }),
        )
        .await;
    }
    svc::unlink_todo_from_book_page(&state.storage_root, &date, &todo_id, &book_id, &page_id)
}

#[tauri::command]
pub async fn create_page_from_todo(
    date: String,
    todo_id: String,
    book_id: String,
    state: State<'_, AppState>,
) -> Result<PageFromTodo, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(
            &url,
            "links/create_page_from_todo",
            serde_json::json!({ "date": date, "todo_id": todo_id, "book_id": book_id }),
        )
        .await;
    }
    svc::create_page_from_todo(&state.storage_root, &date, &todo_id, &book_id)
}

#[tauri::command]
pub async fn create_list_item_from_todo(
    date: String,
    todo_id: String,
    list_id: String,
    state: State<'_, AppState>,
) -> Result<ItemFromTodo, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(
            &url,
            "links/create_list_item_from_todo",
            serde_json::json!({ "date": date, "todo_id": todo_id, "list_id": list_id }),
        )
        .await;
    }
    svc::create_list_item_from_todo(&state.storage_root, &date, &todo_id, &list_id)
}
