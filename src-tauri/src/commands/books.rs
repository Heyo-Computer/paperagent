use tauri::State;
use crate::models::book::{Book, BookSummary};
use crate::services::routing::{agent_rpc, require_agent};
use crate::state::AppState;

#[tauri::command]
pub async fn list_books(state: State<'_, AppState>) -> Result<Vec<BookSummary>, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/list_books", serde_json::json!({})).await
}

#[tauri::command]
pub async fn load_book(book_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/load_book", serde_json::json!({ "book_id": book_id })).await
}

#[tauri::command]
pub async fn create_book(name: String, state: State<'_, AppState>) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/create_book", serde_json::json!({ "name": name })).await
}

#[tauri::command]
pub async fn delete_book(book_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let url = require_agent(&state).await?;
    let _: serde_json::Value = agent_rpc(&url, "books/delete_book", serde_json::json!({ "book_id": book_id })).await?;
    Ok(())
}

#[tauri::command]
pub async fn add_page(book_id: String, title: String, state: State<'_, AppState>) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/add_page", serde_json::json!({ "book_id": book_id, "title": title })).await
}

#[tauri::command]
pub async fn load_page(book_id: String, page_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/load_page", serde_json::json!({ "book_id": book_id, "page_id": page_id })).await
}

#[tauri::command]
pub async fn save_page(book_id: String, page_id: String, content: String, state: State<'_, AppState>) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/save_page", serde_json::json!({ "book_id": book_id, "page_id": page_id, "content": content })).await
}

#[tauri::command]
pub async fn update_page_meta(book_id: String, page_id: String, title: String, state: State<'_, AppState>) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/update_page_meta", serde_json::json!({ "book_id": book_id, "page_id": page_id, "title": title })).await
}

#[tauri::command]
pub async fn reorder_pages(book_id: String, ordered_ids: Vec<String>, state: State<'_, AppState>) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/reorder_pages", serde_json::json!({ "book_id": book_id, "ordered_ids": ordered_ids })).await
}

#[tauri::command]
pub async fn delete_page(book_id: String, page_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    let url = require_agent(&state).await?;
    agent_rpc(&url, "books/delete_page", serde_json::json!({ "book_id": book_id, "page_id": page_id })).await
}
