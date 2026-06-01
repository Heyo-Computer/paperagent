//! Migrate local-filesystem data into the sandbox.
//!
//! Historically the app wrote data to `~/.todo/storage`; the sandbox agent is now
//! the single source of truth (`/data/storage`). For local (libvirt) backends the
//! two are the same bind-mounted bytes, but for cloud/deployed or snapshot
//! backends they are separate filesystems. This reads the local files and ships
//! them to the agent's `migration/import_bundle` RPC so a sandbox can be seeded.

use std::path::Path;
use serde_json::{json, Map, Value};
use tauri::State;

use crate::services::routing::{agent_rpc, require_agent};
use crate::state::AppState;

fn read_json_file(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

/// Read a `specs/` directory into a map of `{ id: markdown }` (id = filename stem).
fn read_specs_dir(dir: &Path) -> Map<String, Value> {
    let mut map = Map::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            if let (Some(stem), Ok(content)) =
                (p.file_stem().and_then(|s| s.to_str()), std::fs::read_to_string(&p))
            {
                map.insert(stem.to_string(), Value::String(content));
            }
        }
    }
    map
}

fn is_digits(s: &str, len: usize) -> bool {
    s.len() == len && s.chars().all(|c| c.is_ascii_digit())
}

/// Walk storage_root/YYYY/MM/DD/day.json → day entries with their specs.
fn collect_days(storage_root: &Path) -> Vec<Value> {
    let mut days = Vec::new();
    let years = match std::fs::read_dir(storage_root) {
        Ok(e) => e,
        Err(_) => return days,
    };
    for y in years.flatten() {
        let yname = y.file_name().to_string_lossy().to_string();
        if !is_digits(&yname, 4) {
            continue;
        }
        let months = match std::fs::read_dir(y.path()) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for m in months.flatten() {
            let mname = m.file_name().to_string_lossy().to_string();
            if !is_digits(&mname, 2) {
                continue;
            }
            let day_dirs = match std::fs::read_dir(m.path()) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for d in day_dirs.flatten() {
                let dname = d.file_name().to_string_lossy().to_string();
                if !is_digits(&dname, 2) {
                    continue;
                }
                let day_json = d.path().join("day.json");
                let Some(entry) = read_json_file(&day_json) else { continue };
                let date = entry
                    .get("date")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}-{}-{}", yname, mname, dname));
                let todos = entry.get("todos").cloned().unwrap_or_else(|| json!([]));
                let specs = read_specs_dir(&d.path().join("specs"));
                days.push(json!({ "date": date, "todos": todos, "specs": specs }));
            }
        }
    }
    days
}

fn collect_backlog(storage_root: &Path) -> Value {
    let items = read_json_file(&storage_root.join("backlog.json"))
        .and_then(|v| v.get("items").cloned())
        .unwrap_or_else(|| json!([]));
    let specs = read_specs_dir(&storage_root.join("backlog").join("specs"));
    json!({ "items": items, "specs": specs })
}

fn collect_lists(storage_root: &Path) -> Vec<Value> {
    let mut lists = Vec::new();
    let dir = storage_root.join("lists");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.file_name().and_then(|n| n.to_str()) == Some("index.json") {
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Some(list) = read_json_file(&p) {
                lists.push(list);
            }
        }
    }
    lists
}

fn collect_books(storage_root: &Path) -> Vec<Value> {
    let mut books = Vec::new();
    let dir = storage_root.join("books");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let Some(book) = read_json_file(&p.join("book.json")) else { continue };
            let mut pages = Map::new();
            if let Ok(page_files) = std::fs::read_dir(p.join("pages")) {
                for pf in page_files.flatten() {
                    let pp = pf.path();
                    if pp.extension().and_then(|x| x.to_str()) != Some("md") {
                        continue;
                    }
                    if let (Some(stem), Ok(content)) =
                        (pp.file_stem().and_then(|s| s.to_str()), std::fs::read_to_string(&pp))
                    {
                        pages.insert(stem.to_string(), Value::String(content));
                    }
                }
            }
            books.push(json!({ "book": book, "pages": pages }));
        }
    }
    books
}

/// Walk the artifacts tree, collecting `{ path, content }` for every file
/// (skipping dotfiles such as the `.index.json`).
fn collect_artifacts(artifacts_dir: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    fn walk(root: &Path, current: &Path, out: &mut Vec<Value>) {
        let entries = match std::fs::read_dir(current) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            let p = e.path();
            let name = match p.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                walk(root, &p, out);
            } else if let Ok(content) = std::fs::read_to_string(&p) {
                if let Ok(rel) = p.strip_prefix(root) {
                    let rel = rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
                    out.push(json!({ "path": rel, "content": content }));
                }
            }
        }
    }
    walk(artifacts_dir, artifacts_dir, &mut out);
    out
}

fn build_bundle(storage_root: &Path, artifacts_dir: &Path) -> Value {
    json!({
        "days": collect_days(storage_root),
        "backlog": collect_backlog(storage_root),
        "lists": collect_lists(storage_root),
        "books": collect_books(storage_root),
        "artifacts": collect_artifacts(artifacts_dir),
    })
}

fn count_bundle(bundle: &Value) -> Value {
    let days = bundle.get("days").and_then(|v| v.as_array());
    let day_count = days.map(|d| d.len()).unwrap_or(0);
    let todo_count: usize = days
        .map(|d| {
            d.iter()
                .map(|day| day.get("todos").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0))
                .sum()
        })
        .unwrap_or(0);
    let backlog = bundle
        .get("backlog")
        .and_then(|b| b.get("items"))
        .and_then(|i| i.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let lists = bundle.get("lists").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let books = bundle.get("books").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    let artifacts = bundle.get("artifacts").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
    json!({
        "days": day_count,
        "todos": todo_count,
        "backlog": backlog,
        "lists": lists,
        "books": books,
        "artifacts": artifacts,
    })
}

/// Report what local data exists vs what the sandbox currently holds. Drives the
/// one-time "import your local data?" prompt in the UI.
#[tauri::command]
pub async fn migration_stats(state: State<'_, AppState>) -> Result<Value, String> {
    let local = build_bundle(&state.storage_root, &state.artifacts_dir);
    let local_counts = count_bundle(&local);
    let url = require_agent(&state).await?;
    let sandbox: Value = agent_rpc(&url, "migration/stats", json!({})).await?;
    Ok(json!({ "local": local_counts, "sandbox": sandbox }))
}

/// Read all local-filesystem data and import it into the sandbox.
#[tauri::command]
pub async fn migrate_local_to_sandbox(state: State<'_, AppState>) -> Result<Value, String> {
    let bundle = build_bundle(&state.storage_root, &state.artifacts_dir);
    let url = require_agent(&state).await?;
    agent_rpc(&url, "migration/import_bundle", json!({ "bundle": bundle })).await
}

// ── Export (sandbox → local ~/.todo) ──

fn write_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, content).map_err(|e| e.to_string())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    write_file(path, &content)
}

fn write_specs(dir: &Path, specs: Option<&Value>) -> Result<(), String> {
    if let Some(map) = specs.and_then(|v| v.as_object()) {
        for (id, content) in map {
            if let Some(text) = content.as_str() {
                write_file(&dir.join(format!("{}.md", id)), text)?;
            }
        }
    }
    Ok(())
}

fn list_summary(entity: &Value) -> Value {
    json!({
        "id": entity.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "name": entity.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "updated_at": entity.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
    })
}

/// Reconstruct ~/.todo (storage + artifacts) from an exported bundle. Inverse of
/// `build_bundle` / the agent's importer. Overwrites entities by id/date; does not
/// delete pre-existing local files not present in the bundle.
fn write_bundle_to_local(bundle: &Value, storage_root: &Path, artifacts_dir: &Path) -> Result<(), String> {
    // Days + specs → storage_root/YYYY/MM/DD/{day.json, specs/*.md}
    for day in bundle.get("days").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]) {
        let date = day.get("date").and_then(|v| v.as_str()).unwrap_or_default();
        let parts: Vec<&str> = date.split('-').collect();
        if parts.len() != 3 {
            continue;
        }
        let dir = storage_root.join(parts[0]).join(parts[1]).join(parts[2]);
        let todos = day.get("todos").cloned().unwrap_or_else(|| json!([]));
        write_json(&dir.join("day.json"), &json!({ "date": date, "todos": todos }))?;
        write_specs(&dir.join("specs"), day.get("specs"))?;
    }

    // Backlog + specs
    if let Some(backlog) = bundle.get("backlog") {
        let items = backlog.get("items").cloned().unwrap_or_else(|| json!([]));
        write_json(&storage_root.join("backlog.json"), &json!({ "items": items }))?;
        write_specs(&storage_root.join("backlog").join("specs"), backlog.get("specs"))?;
    }

    // Lists + index
    let mut list_index: Vec<Value> = Vec::new();
    for list in bundle.get("lists").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]) {
        let id = list.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        write_json(&storage_root.join("lists").join(format!("{}.json", id)), list)?;
        list_index.push(list_summary(list));
    }
    if !list_index.is_empty() {
        write_json(&storage_root.join("lists").join("index.json"), &Value::Array(list_index))?;
    }

    // Books + pages + index
    let mut book_index: Vec<Value> = Vec::new();
    for entry in bundle.get("books").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]) {
        let book = match entry.get("book") {
            Some(b) => b,
            None => continue,
        };
        let id = book.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let book_dir = storage_root.join("books").join(id);
        write_json(&book_dir.join("book.json"), book)?;
        if let Some(pages) = entry.get("pages").and_then(|v| v.as_object()) {
            for (page_id, content) in pages {
                if let Some(text) = content.as_str() {
                    write_file(&book_dir.join("pages").join(format!("{}.md", page_id)), text)?;
                }
            }
        }
        book_index.push(list_summary(book));
    }
    if !book_index.is_empty() {
        write_json(&storage_root.join("books").join("index.json"), &Value::Array(book_index))?;
    }

    // Artifacts (reject path traversal defensively)
    for a in bundle.get("artifacts").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]) {
        let rel = a.get("path").and_then(|v| v.as_str()).unwrap_or_default();
        let content = a.get("content").and_then(|v| v.as_str()).unwrap_or_default();
        if rel.is_empty() || rel.split('/').any(|seg| seg == ".." ) {
            continue;
        }
        write_file(&artifacts_dir.join(rel), content)?;
    }

    Ok(())
}

/// Fetch the sandbox's data and reconstruct the local ~/.todo directory.
/// Reusable by both the Settings command and the recreate-update fallback.
pub(crate) async fn export_to_local(state: &AppState) -> Result<Value, String> {
    let url = require_agent(state).await?;
    let bundle: Value = agent_rpc(&url, "migration/export_bundle", json!({})).await?;
    write_bundle_to_local(&bundle, &state.storage_root, &state.artifacts_dir)?;
    Ok(count_bundle(&bundle))
}

/// Reconstruct the local ~/.todo directory from the sandbox's current data.
#[tauri::command]
pub async fn export_sandbox_to_local(state: State<'_, AppState>) -> Result<Value, String> {
    export_to_local(&state).await
}
