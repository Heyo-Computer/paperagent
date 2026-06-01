use std::path::{Path, PathBuf};
use crate::models::todo::{Backlog, DayEntry, TodoItem};
use crate::models::list::{List, ListSummary};
use crate::models::book::{Book, BookSummary};

pub fn day_dir(storage_root: &Path, date: &str) -> PathBuf {
    // date format: YYYY-MM-DD
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return storage_root.join(date);
    }
    storage_root.join(parts[0]).join(parts[1]).join(parts[2])
}

pub fn ensure_day_dir(storage_root: &Path, date: &str) -> std::io::Result<PathBuf> {
    let dir = day_dir(storage_root, date);
    std::fs::create_dir_all(&dir)?;
    std::fs::create_dir_all(dir.join("specs"))?;
    Ok(dir)
}

pub fn load_day(storage_root: &Path, date: &str) -> DayEntry {
    let dir = day_dir(storage_root, date);
    let path = dir.join("day.json");

    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(entry) => return entry,
                Err(_) => {}
            },
            Err(_) => {}
        }
    }

    DayEntry::new(date.to_string())
}

pub fn save_day(storage_root: &Path, entry: &DayEntry) -> Result<(), String> {
    let dir = ensure_day_dir(storage_root, &entry.date).map_err(|e| e.to_string())?;
    let path = dir.join("day.json");
    let content = serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn load_spec(storage_root: &Path, date: &str, todo_id: &str) -> String {
    let dir = day_dir(storage_root, date);
    let path = dir.join("specs").join(format!("{}.md", todo_id));

    std::fs::read_to_string(&path).unwrap_or_default()
}

pub fn save_spec(storage_root: &Path, date: &str, todo_id: &str, content: &str) -> Result<(), String> {
    let dir = ensure_day_dir(storage_root, date).map_err(|e| e.to_string())?;
    let path = dir.join("specs").join(format!("{}.md", todo_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn load_days_range(storage_root: &Path, offset_start: i64, offset_end: i64) -> Vec<DayEntry> {
    let today = chrono::Local::now().date_naive();
    let mut date = today + chrono::Duration::days(offset_start);
    let end = today + chrono::Duration::days(offset_end);
    let mut entries = Vec::new();
    while date <= end {
        let date_str = date.format("%Y-%m-%d").to_string();
        entries.push(load_day(storage_root, &date_str));
        date += chrono::Duration::days(1);
    }
    entries
}

pub fn add_todo(storage_root: &Path, date: &str, title: &str) -> Result<DayEntry, String> {
    let mut entry = load_day(storage_root, date);
    let now = chrono::Local::now().to_rfc3339();
    let todo = TodoItem {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        completed: false,
        has_spec: false,
        links: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    entry.todos.push(todo);
    save_day(storage_root, &entry)?;
    Ok(entry)
}

pub fn update_todo(storage_root: &Path, date: &str, updated: TodoItem) -> Result<DayEntry, String> {
    let mut entry = load_day(storage_root, date);
    if let Some(todo) = entry.todos.iter_mut().find(|t| t.id == updated.id) {
        todo.title = updated.title;
        todo.completed = updated.completed;
        todo.has_spec = updated.has_spec;
        todo.updated_at = chrono::Local::now().to_rfc3339();
    }
    save_day(storage_root, &entry)?;
    Ok(entry)
}

/// Save the cached calendar events to {data_dir}/calendar/events.json so the agent can read them.
///
/// Merges with any previously cached events (keyed by event id, falling back to
/// start_time+summary) rather than overwriting. The fetch window slides forward over
/// time, so a plain overwrite would silently drop every past event the moment it left
/// the window — merging lets the cache accumulate history that search can index.
pub fn save_calendar_events(data_dir: &Path, events: &[crate::services::calendar::CalendarEvent]) -> Result<(), String> {
    use crate::services::calendar::CalendarEvent;
    use std::collections::HashMap;

    let dir = data_dir.join("calendar");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create calendar dir: {}", e))?;
    let path = dir.join("events.json");

    let key = |e: &CalendarEvent| -> String {
        if e.id.is_empty() {
            format!("{}|{}", e.start_time, e.summary)
        } else {
            e.id.clone()
        }
    };

    let mut merged: Vec<CalendarEvent> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut index: HashMap<String, usize> =
        merged.iter().enumerate().map(|(i, e)| (key(e), i)).collect();

    for ev in events {
        let k = key(ev);
        match index.get(&k) {
            // Freshly fetched copy wins (details may have changed).
            Some(&i) => merged[i] = ev.clone(),
            None => {
                index.insert(k, merged.len());
                merged.push(ev.clone());
            }
        }
    }

    merged.sort_by(|a, b| a.start_time.cmp(&b.start_time));

    let content = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("Failed to write calendar cache: {}", e))
}

pub fn delete_todo(storage_root: &Path, date: &str, todo_id: &str) -> Result<DayEntry, String> {
    let mut entry = load_day(storage_root, date);
    entry.todos.retain(|t| t.id != todo_id);

    // Also remove the spec file if it exists
    let spec_path = day_dir(storage_root, date).join("specs").join(format!("{}.md", todo_id));
    let _ = std::fs::remove_file(spec_path);

    save_day(storage_root, &entry)?;
    Ok(entry)
}

// ── Backlog (undated todos) ──

fn backlog_path(storage_root: &Path) -> PathBuf {
    storage_root.join("backlog.json")
}

fn backlog_specs_dir(storage_root: &Path) -> PathBuf {
    storage_root.join("backlog").join("specs")
}

pub fn load_backlog(storage_root: &Path) -> Backlog {
    let path = backlog_path(storage_root);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(b) = serde_json::from_str(&content) {
                return b;
            }
        }
    }
    Backlog::default()
}

pub fn save_backlog(storage_root: &Path, backlog: &Backlog) -> Result<(), String> {
    std::fs::create_dir_all(storage_root).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(backlog).map_err(|e| e.to_string())?;
    std::fs::write(backlog_path(storage_root), content).map_err(|e| e.to_string())
}

pub fn add_backlog_item(storage_root: &Path, title: &str) -> Result<Backlog, String> {
    let mut backlog = load_backlog(storage_root);
    let now = chrono::Local::now().to_rfc3339();
    backlog.items.push(TodoItem {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        completed: false,
        has_spec: false,
        links: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    });
    save_backlog(storage_root, &backlog)?;
    Ok(backlog)
}

pub fn update_backlog_item(storage_root: &Path, updated: TodoItem) -> Result<Backlog, String> {
    let mut backlog = load_backlog(storage_root);
    if let Some(item) = backlog.items.iter_mut().find(|t| t.id == updated.id) {
        item.title = updated.title;
        item.completed = updated.completed;
        item.has_spec = updated.has_spec;
        item.updated_at = chrono::Local::now().to_rfc3339();
    }
    save_backlog(storage_root, &backlog)?;
    Ok(backlog)
}

pub fn delete_backlog_item(storage_root: &Path, item_id: &str) -> Result<Backlog, String> {
    let mut backlog = load_backlog(storage_root);
    backlog.items.retain(|t| t.id != item_id);

    let spec_path = backlog_specs_dir(storage_root).join(format!("{}.md", item_id));
    let _ = std::fs::remove_file(spec_path);

    save_backlog(storage_root, &backlog)?;
    Ok(backlog)
}

pub fn load_backlog_spec(storage_root: &Path, item_id: &str) -> String {
    let path = backlog_specs_dir(storage_root).join(format!("{}.md", item_id));
    std::fs::read_to_string(&path).unwrap_or_default()
}

pub fn save_backlog_spec(storage_root: &Path, item_id: &str, content: &str) -> Result<(), String> {
    let dir = backlog_specs_dir(storage_root);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.md", item_id));
    std::fs::write(&path, content).map_err(|e| e.to_string())?;

    // Mark has_spec on the item
    let mut backlog = load_backlog(storage_root);
    if let Some(item) = backlog.items.iter_mut().find(|t| t.id == item_id) {
        item.has_spec = true;
        item.updated_at = chrono::Local::now().to_rfc3339();
    }
    save_backlog(storage_root, &backlog)?;
    Ok(())
}

/// Move a backlog item onto a day's todo list. Preserves the item's id and spec.
/// Returns (updated_backlog, updated_day_entry).
pub fn move_backlog_to_day(
    storage_root: &Path,
    item_id: &str,
    date: &str,
) -> Result<(Backlog, DayEntry), String> {
    let mut backlog = load_backlog(storage_root);
    let pos = backlog
        .items
        .iter()
        .position(|t| t.id == item_id)
        .ok_or_else(|| format!("backlog item {} not found", item_id))?;
    let mut item = backlog.items.remove(pos);
    item.updated_at = chrono::Local::now().to_rfc3339();

    // Move spec file from backlog/specs/{id}.md to day/specs/{id}.md if present
    if item.has_spec {
        let src = backlog_specs_dir(storage_root).join(format!("{}.md", item_id));
        if src.exists() {
            let day = ensure_day_dir(storage_root, date).map_err(|e| e.to_string())?;
            let dst = day.join("specs").join(format!("{}.md", item_id));
            std::fs::rename(&src, &dst).map_err(|e| format!("Failed to move spec: {}", e))?;
        }
    }

    let mut entry = load_day(storage_root, date);
    entry.todos.push(item);
    save_day(storage_root, &entry)?;
    save_backlog(storage_root, &backlog)?;
    Ok((backlog, entry))
}

// ── Lists ──

fn lists_root(storage_root: &Path) -> PathBuf {
    storage_root.join("lists")
}

fn lists_index_path(storage_root: &Path) -> PathBuf {
    lists_root(storage_root).join("index.json")
}

fn list_path(storage_root: &Path, list_id: &str) -> PathBuf {
    lists_root(storage_root).join(format!("{}.json", list_id))
}

pub fn ensure_lists_dir(storage_root: &Path) -> std::io::Result<PathBuf> {
    let dir = lists_root(storage_root);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn load_lists_index(storage_root: &Path) -> Vec<ListSummary> {
    let path = lists_index_path(storage_root);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(idx) = serde_json::from_str(&content) {
                return idx;
            }
        }
    }
    Vec::new()
}

pub fn save_lists_index(storage_root: &Path, index: &[ListSummary]) -> Result<(), String> {
    ensure_lists_dir(storage_root).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    std::fs::write(lists_index_path(storage_root), content).map_err(|e| e.to_string())
}

pub fn load_list(storage_root: &Path, list_id: &str) -> Option<List> {
    let path = list_path(storage_root, list_id);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(list) = serde_json::from_str(&content) {
                return Some(list);
            }
        }
    }
    None
}

pub fn save_list(storage_root: &Path, list: &List) -> Result<(), String> {
    ensure_lists_dir(storage_root).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(list_path(storage_root, &list.id), content).map_err(|e| e.to_string())
}

pub fn delete_list_file(storage_root: &Path, list_id: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(list_path(storage_root, list_id));
    Ok(())
}

/// Insert or update the index entry for a list, keeping it sorted by name.
pub fn upsert_list_index(storage_root: &Path, list: &List) -> Result<(), String> {
    let mut index = load_lists_index(storage_root);
    let summary = ListSummary::from(list);
    if let Some(existing) = index.iter_mut().find(|s| s.id == list.id) {
        *existing = summary;
    } else {
        index.push(summary);
    }
    index.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    save_lists_index(storage_root, &index)
}

pub fn remove_list_index(storage_root: &Path, list_id: &str) -> Result<(), String> {
    let mut index = load_lists_index(storage_root);
    index.retain(|s| s.id != list_id);
    save_lists_index(storage_root, &index)
}

// ── Books ──

fn books_root(storage_root: &Path) -> PathBuf {
    storage_root.join("books")
}

fn books_index_path(storage_root: &Path) -> PathBuf {
    books_root(storage_root).join("index.json")
}

fn book_dir(storage_root: &Path, book_id: &str) -> PathBuf {
    books_root(storage_root).join(book_id)
}

fn book_meta_path(storage_root: &Path, book_id: &str) -> PathBuf {
    book_dir(storage_root, book_id).join("book.json")
}

fn page_path(storage_root: &Path, book_id: &str, page_id: &str) -> PathBuf {
    book_dir(storage_root, book_id)
        .join("pages")
        .join(format!("{}.md", page_id))
}

pub fn ensure_books_dir(storage_root: &Path) -> std::io::Result<PathBuf> {
    let dir = books_root(storage_root);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn ensure_book_dir(storage_root: &Path, book_id: &str) -> std::io::Result<PathBuf> {
    let dir = book_dir(storage_root, book_id);
    std::fs::create_dir_all(dir.join("pages"))?;
    Ok(dir)
}

pub fn load_books_index(storage_root: &Path) -> Vec<BookSummary> {
    let path = books_index_path(storage_root);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(idx) = serde_json::from_str(&content) {
                return idx;
            }
        }
    }
    Vec::new()
}

pub fn save_books_index(storage_root: &Path, index: &[BookSummary]) -> Result<(), String> {
    ensure_books_dir(storage_root).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    std::fs::write(books_index_path(storage_root), content).map_err(|e| e.to_string())
}

pub fn load_book(storage_root: &Path, book_id: &str) -> Option<Book> {
    let path = book_meta_path(storage_root, book_id);
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(book) = serde_json::from_str(&content) {
                return Some(book);
            }
        }
    }
    None
}

pub fn save_book(storage_root: &Path, book: &Book) -> Result<(), String> {
    ensure_book_dir(storage_root, &book.id).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(book).map_err(|e| e.to_string())?;
    std::fs::write(book_meta_path(storage_root, &book.id), content).map_err(|e| e.to_string())
}

pub fn delete_book_dir(storage_root: &Path, book_id: &str) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(book_dir(storage_root, book_id));
    Ok(())
}

pub fn load_page(storage_root: &Path, book_id: &str, page_id: &str) -> String {
    std::fs::read_to_string(page_path(storage_root, book_id, page_id)).unwrap_or_default()
}

pub fn save_page(storage_root: &Path, book_id: &str, page_id: &str, content: &str) -> Result<(), String> {
    ensure_book_dir(storage_root, book_id).map_err(|e| e.to_string())?;
    std::fs::write(page_path(storage_root, book_id, page_id), content).map_err(|e| e.to_string())
}

pub fn delete_page_file(storage_root: &Path, book_id: &str, page_id: &str) -> Result<(), String> {
    let _ = std::fs::remove_file(page_path(storage_root, book_id, page_id));
    Ok(())
}

/// Insert or update the index entry for a book, keeping it sorted by name.
pub fn upsert_book_index(storage_root: &Path, book: &Book) -> Result<(), String> {
    let mut index = load_books_index(storage_root);
    let summary = BookSummary::from(book);
    if let Some(existing) = index.iter_mut().find(|s| s.id == book.id) {
        *existing = summary;
    } else {
        index.push(summary);
    }
    index.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    save_books_index(storage_root, &index)
}

pub fn remove_book_index(storage_root: &Path, book_id: &str) -> Result<(), String> {
    let mut index = load_books_index(storage_root);
    index.retain(|s| s.id != book_id);
    save_books_index(storage_root, &index)
}

// ── Lists CRUD ──

use crate::models::list::{ListField, ListItem};
use crate::models::book::BookPage;

pub fn create_list(storage_root: &Path, name: &str, fields: Vec<ListField>) -> Result<List, String> {
    let now = chrono::Local::now().to_rfc3339();
    let list = List {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        fields,
        items: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    save_list(storage_root, &list)?;
    upsert_list_index(storage_root, &list)?;
    Ok(list)
}

pub fn get_list(storage_root: &Path, list_id: &str) -> Result<List, String> {
    load_list(storage_root, list_id).ok_or_else(|| format!("list {} not found", list_id))
}

/// Update a list's name and schema. When a field is removed, its key is
/// dropped from every item's `values`.
pub fn update_list_meta(
    storage_root: &Path,
    list_id: &str,
    name: &str,
    fields: Vec<ListField>,
) -> Result<List, String> {
    let mut list = get_list(storage_root, list_id)?;
    let kept_keys: std::collections::HashSet<String> =
        fields.iter().map(|f| f.key.clone()).collect();
    for item in list.items.iter_mut() {
        item.values.retain(|k, _| kept_keys.contains(k));
    }
    list.name = name.to_string();
    list.fields = fields;
    list.updated_at = chrono::Local::now().to_rfc3339();
    save_list(storage_root, &list)?;
    upsert_list_index(storage_root, &list)?;
    Ok(list)
}

pub fn delete_list(storage_root: &Path, list_id: &str) -> Result<(), String> {
    delete_list_file(storage_root, list_id)?;
    remove_list_index(storage_root, list_id)
}

pub fn add_list_item(
    storage_root: &Path,
    list_id: &str,
    values: serde_json::Map<String, serde_json::Value>,
) -> Result<List, String> {
    let mut list = get_list(storage_root, list_id)?;
    let now = chrono::Local::now().to_rfc3339();
    list.items.push(ListItem {
        id: uuid::Uuid::new_v4().to_string(),
        values,
        linked_todos: Vec::new(),
        archived: false,
        created_at: now.clone(),
        updated_at: now,
    });
    list.updated_at = chrono::Local::now().to_rfc3339();
    save_list(storage_root, &list)?;
    upsert_list_index(storage_root, &list)?;
    Ok(list)
}

pub fn update_list_item(storage_root: &Path, list_id: &str, updated: ListItem) -> Result<List, String> {
    let mut list = get_list(storage_root, list_id)?;
    if let Some(item) = list.items.iter_mut().find(|i| i.id == updated.id) {
        item.values = updated.values;
        item.archived = updated.archived;
        item.updated_at = chrono::Local::now().to_rfc3339();
    }
    list.updated_at = chrono::Local::now().to_rfc3339();
    save_list(storage_root, &list)?;
    upsert_list_index(storage_root, &list)?;
    Ok(list)
}

pub fn delete_list_item(storage_root: &Path, list_id: &str, item_id: &str) -> Result<List, String> {
    let mut list = get_list(storage_root, list_id)?;
    list.items.retain(|i| i.id != item_id);
    list.updated_at = chrono::Local::now().to_rfc3339();
    save_list(storage_root, &list)?;
    upsert_list_index(storage_root, &list)?;
    Ok(list)
}

pub fn list_lists(storage_root: &Path) -> Vec<ListSummary> {
    load_lists_index(storage_root)
}

// ── Books CRUD ──

pub fn create_book(storage_root: &Path, name: &str) -> Result<Book, String> {
    let now = chrono::Local::now().to_rfc3339();
    let book = Book {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        pages: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    };
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    Ok(book)
}

pub fn get_book(storage_root: &Path, book_id: &str) -> Result<Book, String> {
    load_book(storage_root, book_id).ok_or_else(|| format!("book {} not found", book_id))
}

pub fn list_books(storage_root: &Path) -> Vec<BookSummary> {
    load_books_index(storage_root)
}

pub fn delete_book(storage_root: &Path, book_id: &str) -> Result<(), String> {
    delete_book_dir(storage_root, book_id)?;
    remove_book_index(storage_root, book_id)
}

pub fn add_page(storage_root: &Path, book_id: &str, title: &str) -> Result<Book, String> {
    let mut book = get_book(storage_root, book_id)?;
    let now = chrono::Local::now().to_rfc3339();
    let order = book.pages.iter().map(|p| p.order).max().unwrap_or(-1) + 1;
    let page_id = uuid::Uuid::new_v4().to_string();
    book.pages.push(BookPage {
        id: page_id.clone(),
        title: title.to_string(),
        order,
        linked_todos: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
    });
    book.updated_at = chrono::Local::now().to_rfc3339();
    // Create an empty page body file.
    save_page(storage_root, book_id, &page_id, "")?;
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    Ok(book)
}

pub fn save_page_content(
    storage_root: &Path,
    book_id: &str,
    page_id: &str,
    content: &str,
) -> Result<Book, String> {
    save_page(storage_root, book_id, page_id, content)?;
    let mut book = get_book(storage_root, book_id)?;
    if let Some(page) = book.pages.iter_mut().find(|p| p.id == page_id) {
        page.updated_at = chrono::Local::now().to_rfc3339();
    }
    book.updated_at = chrono::Local::now().to_rfc3339();
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    Ok(book)
}

pub fn update_page_meta(
    storage_root: &Path,
    book_id: &str,
    page_id: &str,
    title: &str,
) -> Result<Book, String> {
    let mut book = get_book(storage_root, book_id)?;
    if let Some(page) = book.pages.iter_mut().find(|p| p.id == page_id) {
        page.title = title.to_string();
        page.updated_at = chrono::Local::now().to_rfc3339();
    }
    book.updated_at = chrono::Local::now().to_rfc3339();
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    Ok(book)
}

/// Reorder pages to match `ordered_ids`; pages not present keep trailing order.
pub fn reorder_pages(storage_root: &Path, book_id: &str, ordered_ids: Vec<String>) -> Result<Book, String> {
    let mut book = get_book(storage_root, book_id)?;
    for (idx, id) in ordered_ids.iter().enumerate() {
        if let Some(page) = book.pages.iter_mut().find(|p| &p.id == id) {
            page.order = idx as i64;
        }
    }
    book.pages.sort_by_key(|p| p.order);
    book.updated_at = chrono::Local::now().to_rfc3339();
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    Ok(book)
}

pub fn delete_page(storage_root: &Path, book_id: &str, page_id: &str) -> Result<Book, String> {
    delete_page_file(storage_root, book_id, page_id)?;
    let mut book = get_book(storage_root, book_id)?;
    book.pages.retain(|p| p.id != page_id);
    book.updated_at = chrono::Local::now().to_rfc3339();
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    Ok(book)
}

// ── Links (bidirectional todo <-> list item / book page, T-009) ──

use crate::models::link::{LinkRef, TodoRef};

/// Add an outgoing `LinkRef` onto a todo (deduped). `date` empty → backlog item.
/// Returns the todo's title so callers can label the reverse `TodoRef`.
fn add_link_to_todo(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    link: LinkRef,
) -> Result<String, String> {
    if date.is_empty() {
        let mut backlog = load_backlog(storage_root);
        let todo = backlog
            .items
            .iter_mut()
            .find(|t| t.id == todo_id)
            .ok_or_else(|| format!("todo {} not found in backlog", todo_id))?;
        if !todo.links.iter().any(|l| {
            l.kind == link.kind && l.target_id == link.target_id && l.sub_id == link.sub_id
        }) {
            todo.links.push(link);
            todo.updated_at = chrono::Local::now().to_rfc3339();
        }
        let title = todo.title.clone();
        save_backlog(storage_root, &backlog)?;
        Ok(title)
    } else {
        let mut entry = load_day(storage_root, date);
        let todo = entry
            .todos
            .iter_mut()
            .find(|t| t.id == todo_id)
            .ok_or_else(|| format!("todo {} not found on {}", todo_id, date))?;
        if !todo.links.iter().any(|l| {
            l.kind == link.kind && l.target_id == link.target_id && l.sub_id == link.sub_id
        }) {
            todo.links.push(link);
            todo.updated_at = chrono::Local::now().to_rfc3339();
        }
        let title = todo.title.clone();
        save_day(storage_root, &entry)?;
        Ok(title)
    }
}

/// Remove the matching outgoing link from a todo. `date` empty → backlog item.
fn remove_link_from_todo(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    kind: &str,
    target_id: &str,
    sub_id: &str,
) -> Result<(), String> {
    let matches = |l: &LinkRef| l.kind == kind && l.target_id == target_id && l.sub_id == sub_id;
    if date.is_empty() {
        let mut backlog = load_backlog(storage_root);
        if let Some(todo) = backlog.items.iter_mut().find(|t| t.id == todo_id) {
            todo.links.retain(|l| !matches(l));
            todo.updated_at = chrono::Local::now().to_rfc3339();
        }
        save_backlog(storage_root, &backlog)
    } else {
        let mut entry = load_day(storage_root, date);
        if let Some(todo) = entry.todos.iter_mut().find(|t| t.id == todo_id) {
            todo.links.retain(|l| !matches(l));
            todo.updated_at = chrono::Local::now().to_rfc3339();
        }
        save_day(storage_root, &entry)
    }
}

pub fn link_todo_to_list_item(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    list_id: &str,
    item_id: &str,
) -> Result<List, String> {
    let mut list = get_list(storage_root, list_id)?;
    if !list.items.iter().any(|i| i.id == item_id) {
        return Err(format!("item {} not found in list {}", item_id, list_id));
    }
    let label = list.name.clone();
    let todo_title = add_link_to_todo(
        storage_root,
        date,
        todo_id,
        LinkRef {
            kind: "list".to_string(),
            target_id: list_id.to_string(),
            sub_id: item_id.to_string(),
            label,
        },
    )?;
    let item = list.items.iter_mut().find(|i| i.id == item_id).unwrap();
    if !item
        .linked_todos
        .iter()
        .any(|r| r.todo_id == todo_id && r.date == date)
    {
        item.linked_todos.push(TodoRef {
            date: date.to_string(),
            todo_id: todo_id.to_string(),
            label: todo_title,
        });
        item.updated_at = chrono::Local::now().to_rfc3339();
    }
    list.updated_at = chrono::Local::now().to_rfc3339();
    save_list(storage_root, &list)?;
    upsert_list_index(storage_root, &list)?;
    Ok(list)
}

pub fn unlink_todo_from_list_item(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    list_id: &str,
    item_id: &str,
) -> Result<List, String> {
    let mut list = get_list(storage_root, list_id)?;
    if let Some(item) = list.items.iter_mut().find(|i| i.id == item_id) {
        item.linked_todos
            .retain(|r| !(r.todo_id == todo_id && r.date == date));
        item.updated_at = chrono::Local::now().to_rfc3339();
    }
    list.updated_at = chrono::Local::now().to_rfc3339();
    save_list(storage_root, &list)?;
    upsert_list_index(storage_root, &list)?;
    remove_link_from_todo(storage_root, date, todo_id, "list", list_id, item_id)?;
    Ok(list)
}

pub fn link_todo_to_book_page(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    book_id: &str,
    page_id: &str,
) -> Result<Book, String> {
    let mut book = get_book(storage_root, book_id)?;
    let page_title = book
        .pages
        .iter()
        .find(|p| p.id == page_id)
        .ok_or_else(|| format!("page {} not found in book {}", page_id, book_id))?
        .title
        .clone();
    let todo_title = add_link_to_todo(
        storage_root,
        date,
        todo_id,
        LinkRef {
            kind: "book".to_string(),
            target_id: book_id.to_string(),
            sub_id: page_id.to_string(),
            label: page_title,
        },
    )?;
    let page = book.pages.iter_mut().find(|p| p.id == page_id).unwrap();
    if !page
        .linked_todos
        .iter()
        .any(|r| r.todo_id == todo_id && r.date == date)
    {
        page.linked_todos.push(TodoRef {
            date: date.to_string(),
            todo_id: todo_id.to_string(),
            label: todo_title,
        });
        page.updated_at = chrono::Local::now().to_rfc3339();
    }
    book.updated_at = chrono::Local::now().to_rfc3339();
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    Ok(book)
}

pub fn unlink_todo_from_book_page(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    book_id: &str,
    page_id: &str,
) -> Result<Book, String> {
    let mut book = get_book(storage_root, book_id)?;
    if let Some(page) = book.pages.iter_mut().find(|p| p.id == page_id) {
        page.linked_todos
            .retain(|r| !(r.todo_id == todo_id && r.date == date));
        page.updated_at = chrono::Local::now().to_rfc3339();
    }
    book.updated_at = chrono::Local::now().to_rfc3339();
    save_book(storage_root, &book)?;
    upsert_book_index(storage_root, &book)?;
    remove_link_from_todo(storage_root, date, todo_id, "book", book_id, page_id)?;
    Ok(book)
}

// ── Create-from-todo (T-011) ──

/// Result of creating a book page from a todo: the updated book plus the new page id.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PageFromTodo {
    pub book: Book,
    pub page_id: String,
}

/// Result of creating a list item from a todo: the updated list plus the new item id.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct ItemFromTodo {
    pub list: List,
    pub item_id: String,
}

/// Create a new page in `book_id` seeded from the todo: title = todo title, body =
/// the todo's spec (falling back to a `# {title}` heading), then bidirectionally
/// link the todo and the new page.
pub fn create_page_from_todo(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    book_id: &str,
) -> Result<PageFromTodo, String> {
    let title = load_day(storage_root, date)
        .todos
        .iter()
        .find(|t| t.id == todo_id)
        .map(|t| t.title.clone())
        .ok_or_else(|| format!("todo {} not found on {}", todo_id, date))?;
    let spec = load_spec(storage_root, date, todo_id);
    let body = if spec.trim().is_empty() {
        format!("# {}\n", title)
    } else {
        spec
    };
    let book = add_page(storage_root, book_id, &title)?;
    let page_id = book
        .pages
        .last()
        .map(|p| p.id.clone())
        .ok_or_else(|| "failed to create page".to_string())?;
    save_page(storage_root, book_id, &page_id, &body)?;
    let book = link_todo_to_book_page(storage_root, date, todo_id, book_id, &page_id)?;
    Ok(PageFromTodo { book, page_id })
}

/// Create a new item in `list_id` seeded from the todo: the first text field (or
/// the first field) is defaulted to the todo title, then bidirectionally link the
/// todo and the new item.
pub fn create_list_item_from_todo(
    storage_root: &Path,
    date: &str,
    todo_id: &str,
    list_id: &str,
) -> Result<ItemFromTodo, String> {
    use crate::models::list::FieldKind;
    let title = load_day(storage_root, date)
        .todos
        .iter()
        .find(|t| t.id == todo_id)
        .map(|t| t.title.clone())
        .ok_or_else(|| format!("todo {} not found on {}", todo_id, date))?;
    let list = get_list(storage_root, list_id)?;
    let seed_key = list
        .fields
        .iter()
        .find(|f| matches!(f.kind, FieldKind::Text))
        .or_else(|| list.fields.first())
        .map(|f| f.key.clone());
    let mut values = serde_json::Map::new();
    if let Some(key) = seed_key {
        values.insert(key, serde_json::Value::String(title));
    }
    let list = add_list_item(storage_root, list_id, values)?;
    let item_id = list
        .items
        .last()
        .map(|i| i.id.clone())
        .ok_or_else(|| "failed to create item".to_string())?;
    let list = link_todo_to_list_item(storage_root, date, todo_id, list_id, &item_id)?;
    Ok(ItemFromTodo { list, item_id })
}

#[cfg(test)]
mod link_tests {
    use super::*;

    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("planner-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn list_link_is_bidirectional_and_persists() {
        let root = tmp_root();
        let date = "2026-05-29";

        let todo_id = add_todo(&root, date, "Daily standup").unwrap().todos[0].id.clone();
        let list = create_list(&root, "Customers", vec![]).unwrap();
        let item_id = add_list_item(&root, &list.id, serde_json::Map::new())
            .unwrap()
            .items[0]
            .id
            .clone();

        link_todo_to_list_item(&root, date, &todo_id, &list.id, &item_id).unwrap();

        // Reload both sides from disk to prove persistence, not in-memory state.
        let todo = load_day(&root, date).todos.into_iter().find(|t| t.id == todo_id).unwrap();
        assert_eq!(todo.links.len(), 1, "todo should carry one outgoing link");
        assert_eq!(todo.links[0].kind, "list");
        assert_eq!(todo.links[0].target_id, list.id);
        assert_eq!(todo.links[0].sub_id, item_id);

        let item = load_list(&root, &list.id).unwrap().items.into_iter().find(|i| i.id == item_id).unwrap();
        assert_eq!(item.linked_todos.len(), 1, "item should carry one linked todo");
        assert_eq!(item.linked_todos[0].todo_id, todo_id);
        assert_eq!(item.linked_todos[0].date, date);

        unlink_todo_from_list_item(&root, date, &todo_id, &list.id, &item_id).unwrap();
        let todo = load_day(&root, date).todos.into_iter().find(|t| t.id == todo_id).unwrap();
        assert!(todo.links.is_empty(), "unlink should clear the todo side");
        let item = load_list(&root, &list.id).unwrap().items.into_iter().find(|i| i.id == item_id).unwrap();
        assert!(item.linked_todos.is_empty(), "unlink should clear the item side");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn book_link_is_bidirectional_and_persists() {
        let root = tmp_root();
        let date = "2026-05-29";

        let todo_id = add_todo(&root, date, "Daily standup").unwrap().todos[0].id.clone();
        let book = create_book(&root, "Standup notes").unwrap();
        let page_id = add_page(&root, &book.id, "May 29").unwrap().pages[0].id.clone();

        link_todo_to_book_page(&root, date, &todo_id, &book.id, &page_id).unwrap();

        let todo = load_day(&root, date).todos.into_iter().find(|t| t.id == todo_id).unwrap();
        assert_eq!(todo.links.len(), 1);
        assert_eq!(todo.links[0].kind, "book");
        assert_eq!(todo.links[0].sub_id, page_id);

        let page = load_book(&root, &book.id).unwrap().pages.into_iter().find(|p| p.id == page_id).unwrap();
        assert_eq!(page.linked_todos.len(), 1);
        assert_eq!(page.linked_todos[0].todo_id, todo_id);

        unlink_todo_from_book_page(&root, date, &todo_id, &book.id, &page_id).unwrap();
        let todo = load_day(&root, date).todos.into_iter().find(|t| t.id == todo_id).unwrap();
        assert!(todo.links.is_empty());
        let page = load_book(&root, &book.id).unwrap().pages.into_iter().find(|p| p.id == page_id).unwrap();
        assert!(page.linked_todos.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_page_from_todo_seeds_spec_and_links() {
        let root = tmp_root();
        let date = "2026-05-29";

        let todo_id = add_todo(&root, date, "Daily standup").unwrap().todos[0].id.clone();
        save_spec(&root, date, &todo_id, "## Notes\n- shipped the thing").unwrap();
        let book = create_book(&root, "Standup notes").unwrap();

        let res = create_page_from_todo(&root, date, &todo_id, &book.id).unwrap();
        let page = res.book.pages.iter().find(|p| p.id == res.page_id).unwrap();
        assert_eq!(page.title, "Daily standup");

        // Body is seeded from the spec, persisted to disk.
        let body = load_page(&root, &book.id, &res.page_id);
        assert_eq!(body, "## Notes\n- shipped the thing");

        // Link exists on both sides after reload.
        let todo = load_day(&root, date).todos.into_iter().find(|t| t.id == todo_id).unwrap();
        assert_eq!(todo.links.len(), 1);
        assert_eq!(todo.links[0].kind, "book");
        assert_eq!(todo.links[0].sub_id, res.page_id);
        let page = load_book(&root, &book.id).unwrap().pages.into_iter().find(|p| p.id == res.page_id).unwrap();
        assert_eq!(page.linked_todos.len(), 1);
        assert_eq!(page.linked_todos[0].todo_id, todo_id);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_page_from_todo_falls_back_to_heading_without_spec() {
        let root = tmp_root();
        let date = "2026-05-29";
        let todo_id = add_todo(&root, date, "Untitled meeting").unwrap().todos[0].id.clone();
        let book = create_book(&root, "Notes").unwrap();

        let res = create_page_from_todo(&root, date, &todo_id, &book.id).unwrap();
        let body = load_page(&root, &book.id, &res.page_id);
        assert_eq!(body, "# Untitled meeting\n");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn create_list_item_from_todo_seeds_title_and_links() {
        let root = tmp_root();
        let date = "2026-05-29";
        let todo_id = add_todo(&root, date, "Acme Corp").unwrap().todos[0].id.clone();
        let fields = vec![ListField {
            key: "name".to_string(),
            label: "Name".to_string(),
            kind: crate::models::list::FieldKind::Text,
            options: None,
        }];
        let list = create_list(&root, "Customers", fields).unwrap();

        let res = create_list_item_from_todo(&root, date, &todo_id, &list.id).unwrap();
        let item = res.list.items.iter().find(|i| i.id == res.item_id).unwrap();
        assert_eq!(
            item.values.get("name").and_then(|v| v.as_str()),
            Some("Acme Corp"),
            "the first text field should be seeded with the todo title"
        );

        let todo = load_day(&root, date).todos.into_iter().find(|t| t.id == todo_id).unwrap();
        assert_eq!(todo.links.len(), 1);
        assert_eq!(todo.links[0].kind, "list");
        assert_eq!(todo.links[0].sub_id, res.item_id);
        let item = load_list(&root, &list.id).unwrap().items.into_iter().find(|i| i.id == res.item_id).unwrap();
        assert_eq!(item.linked_todos.len(), 1);
        assert_eq!(item.linked_todos[0].todo_id, todo_id);

        let _ = std::fs::remove_dir_all(&root);
    }
}
