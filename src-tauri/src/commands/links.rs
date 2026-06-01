use tauri::State;
use crate::models::book::Book;
use crate::models::list::List;
use crate::services::routing::{agent_rpc, require_agent};
use crate::services::storage::{ItemFromTodo, PageFromTodo};
use crate::state::AppState;

#[tauri::command]
pub async fn link_todo_to_list_item(
    date: String,
    todo_id: String,
    list_id: String,
    item_id: String,
    state: State<'_, AppState>,
) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(
        &url,
        "links/link_todo_to_list_item",
        serde_json::json!({ "date": date, "todo_id": todo_id, "list_id": list_id, "item_id": item_id }),
    )
    .await
}

#[tauri::command]
pub async fn unlink_todo_from_list_item(
    date: String,
    todo_id: String,
    list_id: String,
    item_id: String,
    state: State<'_, AppState>,
) -> Result<List, String> {
    let url = require_agent(&state).await?;
    agent_rpc(
        &url,
        "links/unlink_todo_from_list_item",
        serde_json::json!({ "date": date, "todo_id": todo_id, "list_id": list_id, "item_id": item_id }),
    )
    .await
}

#[tauri::command]
pub async fn link_todo_to_book_page(
    date: String,
    todo_id: String,
    book_id: String,
    page_id: String,
    state: State<'_, AppState>,
) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(
        &url,
        "links/link_todo_to_book_page",
        serde_json::json!({ "date": date, "todo_id": todo_id, "book_id": book_id, "page_id": page_id }),
    )
    .await
}

#[tauri::command]
pub async fn unlink_todo_from_book_page(
    date: String,
    todo_id: String,
    book_id: String,
    page_id: String,
    state: State<'_, AppState>,
) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(
        &url,
        "links/unlink_todo_from_book_page",
        serde_json::json!({ "date": date, "todo_id": todo_id, "book_id": book_id, "page_id": page_id }),
    )
    .await
}

#[tauri::command]
pub async fn create_page_from_todo(
    date: String,
    todo_id: String,
    book_id: String,
    state: State<'_, AppState>,
) -> Result<PageFromTodo, String> {
    let url = require_agent(&state).await?;
    agent_rpc(
        &url,
        "links/create_page_from_todo",
        serde_json::json!({ "date": date, "todo_id": todo_id, "book_id": book_id }),
    )
    .await
}

#[tauri::command]
pub async fn create_list_item_from_todo(
    date: String,
    todo_id: String,
    list_id: String,
    state: State<'_, AppState>,
) -> Result<ItemFromTodo, String> {
    let url = require_agent(&state).await?;
    agent_rpc(
        &url,
        "links/create_list_item_from_todo",
        serde_json::json!({ "date": date, "todo_id": todo_id, "list_id": list_id }),
    )
    .await
}
