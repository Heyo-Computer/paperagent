use tauri::State;
use crate::models::book::{Book, BookSummary};
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
pub async fn list_books(state: State<'_, AppState>) -> Result<Vec<BookSummary>, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/list_books", serde_json::json!({})).await;
    }
    Ok(svc::list_books(&state.storage_root))
}

#[tauri::command]
pub async fn load_book(book_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/load_book", serde_json::json!({ "book_id": book_id })).await;
    }
    svc::get_book(&state.storage_root, &book_id)
}

#[tauri::command]
pub async fn create_book(name: String, state: State<'_, AppState>) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/create_book", serde_json::json!({ "name": name })).await;
    }
    svc::create_book(&state.storage_root, &name)
}

#[tauri::command]
pub async fn delete_book(book_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(url) = agent_url(&state) {
        let _: serde_json::Value = agent_rpc(&url, "books/delete_book", serde_json::json!({ "book_id": book_id })).await?;
        return Ok(());
    }
    svc::delete_book(&state.storage_root, &book_id)
}

#[tauri::command]
pub async fn add_page(book_id: String, title: String, state: State<'_, AppState>) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/add_page", serde_json::json!({ "book_id": book_id, "title": title })).await;
    }
    svc::add_page(&state.storage_root, &book_id, &title)
}

#[tauri::command]
pub async fn load_page(book_id: String, page_id: String, state: State<'_, AppState>) -> Result<String, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/load_page", serde_json::json!({ "book_id": book_id, "page_id": page_id })).await;
    }
    Ok(svc::load_page(&state.storage_root, &book_id, &page_id))
}

#[tauri::command]
pub async fn save_page(book_id: String, page_id: String, content: String, state: State<'_, AppState>) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/save_page", serde_json::json!({ "book_id": book_id, "page_id": page_id, "content": content })).await;
    }
    svc::save_page_content(&state.storage_root, &book_id, &page_id, &content)
}

#[tauri::command]
pub async fn update_page_meta(book_id: String, page_id: String, title: String, state: State<'_, AppState>) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/update_page_meta", serde_json::json!({ "book_id": book_id, "page_id": page_id, "title": title })).await;
    }
    svc::update_page_meta(&state.storage_root, &book_id, &page_id, &title)
}

#[tauri::command]
pub async fn reorder_pages(book_id: String, ordered_ids: Vec<String>, state: State<'_, AppState>) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/reorder_pages", serde_json::json!({ "book_id": book_id, "ordered_ids": ordered_ids })).await;
    }
    svc::reorder_pages(&state.storage_root, &book_id, ordered_ids)
}

#[tauri::command]
pub async fn delete_page(book_id: String, page_id: String, state: State<'_, AppState>) -> Result<Book, String> {
    if let Some(url) = agent_url(&state) {
        return agent_rpc(&url, "books/delete_page", serde_json::json!({ "book_id": book_id, "page_id": page_id })).await;
    }
    svc::delete_page(&state.storage_root, &book_id, &page_id)
}
