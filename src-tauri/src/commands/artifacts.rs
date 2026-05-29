use std::path::{Component, Path, PathBuf};
use tauri::State;
use crate::models::artifact::{Artifact, ArtifactIndex};
use crate::state::AppState;

fn load_index(state: &AppState) -> ArtifactIndex {
    let path = state.artifacts_dir.join(".index.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_else(|_| ArtifactIndex::new())
    } else {
        ArtifactIndex::new()
    }
}

fn save_index(state: &AppState, index: &ArtifactIndex) -> Result<(), String> {
    let path = state.artifacts_dir.join(".index.json");
    let content = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Resolve a user-supplied relative path against the artifacts root, rejecting
/// any path that would escape the root via `..`, absolute components, etc.
fn resolve_relative(state: &AppState, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    for comp in p.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(format!("Invalid path '{}': only relative segments allowed", rel)),
        }
    }
    if rel.contains('\0') {
        return Err("Invalid path: NUL byte".to_string());
    }
    Ok(state.artifacts_dir.join(p))
}

fn rel_path_string(state: &AppState, abs: &Path) -> String {
    abs.strip_prefix(&state.artifacts_dir)
        .map(|p| p.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"))
        .unwrap_or_default()
}

fn entry_to_artifact(
    state: &AppState,
    abs: &Path,
    index_lookup: &std::collections::HashMap<String, String>,
) -> Option<Artifact> {
    let metadata = std::fs::metadata(abs).ok()?;
    let name = abs.file_name().and_then(|n| n.to_str())?.to_string();
    if name.starts_with('.') {
        return None;
    }
    let relative_path = rel_path_string(state, abs);
    let created_at = index_lookup.get(&relative_path).cloned().unwrap_or_else(|| {
        metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| chrono::DateTime::<chrono::Local>::from(std::time::UNIX_EPOCH + d).to_rfc3339())
            .unwrap_or_default()
    });
    Some(Artifact {
        name,
        path: abs.to_string_lossy().to_string(),
        relative_path,
        size: if metadata.is_dir() { 0 } else { metadata.len() },
        created_at,
        is_dir: metadata.is_dir(),
    })
}

/// List artifacts inside `dir` (relative to the artifacts root). Empty string
/// or omitted = root. Returns folders first, then files, each sorted newest-first.
#[tauri::command]
pub fn list_artifacts(dir: Option<String>, state: State<AppState>) -> Vec<Artifact> {
    let dir_rel = dir.unwrap_or_default();
    let abs_dir = match resolve_relative(&state, &dir_rel) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    if !abs_dir.exists() {
        return Vec::new();
    }

    let index = load_index(&state);
    let mut lookup: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for a in &index.artifacts {
        lookup.insert(a.relative_path.clone(), a.created_at.clone());
    }

    let entries = match std::fs::read_dir(&abs_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut folders: Vec<Artifact> = Vec::new();
    let mut files: Vec<Artifact> = Vec::new();
    for entry in entries.flatten() {
        if let Some(a) = entry_to_artifact(&state, &entry.path(), &lookup) {
            if a.is_dir { folders.push(a) } else { files.push(a) }
        }
    }

    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    folders.into_iter().chain(files.into_iter()).collect()
}

/// Recursively list every artifact (files and folders) under the root, flattened.
/// Used to populate @-mention candidates so nested files and folders are reachable
/// without navigating into them. Folders sorted by path, files newest-first.
#[tauri::command]
pub fn list_all_artifacts(state: State<AppState>) -> Vec<Artifact> {
    let index = load_index(&state);
    let mut lookup: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for a in &index.artifacts {
        lookup.insert(a.relative_path.clone(), a.created_at.clone());
    }

    let mut folders: Vec<Artifact> = Vec::new();
    let mut files: Vec<Artifact> = Vec::new();
    walk_all(&state, &state.artifacts_dir, &lookup, &mut folders, &mut files);

    folders.sort_by(|a, b| a.relative_path.to_lowercase().cmp(&b.relative_path.to_lowercase()));
    files.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    folders.into_iter().chain(files.into_iter()).collect()
}

fn walk_all(
    state: &AppState,
    current: &Path,
    lookup: &std::collections::HashMap<String, String>,
    folders: &mut Vec<Artifact>,
    files: &mut Vec<Artifact>,
) {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(a) = entry_to_artifact(state, &path, lookup) {
            if a.is_dir {
                folders.push(a);
                walk_all(state, &path, lookup, folders, files);
            } else {
                files.push(a);
            }
        }
    }
}

#[tauri::command]
pub fn read_artifact(path: String, state: State<AppState>) -> Result<String, String> {
    let abs = resolve_relative(&state, &path)?;
    std::fs::read_to_string(&abs).map_err(|e| format!("Failed to read artifact: {}", e))
}

/// Save a file. `path` is relative to the artifacts root and may include
/// subdirectories; any missing parent directories are created.
#[tauri::command]
pub fn save_artifact(path: String, content: String, state: State<AppState>) -> Result<Artifact, String> {
    let _ = std::fs::create_dir_all(&state.artifacts_dir);
    let abs = resolve_relative(&state, &path)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }
    std::fs::write(&abs, &content).map_err(|e| format!("Failed to write artifact: {}", e))?;

    let metadata = std::fs::metadata(&abs).map_err(|e| e.to_string())?;
    let relative_path = rel_path_string(&state, &abs);
    let artifact = Artifact {
        name: abs.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string(),
        path: abs.to_string_lossy().to_string(),
        relative_path: relative_path.clone(),
        size: metadata.len(),
        created_at: chrono::Local::now().to_rfc3339(),
        is_dir: false,
    };

    let mut index = load_index(&state);
    index.artifacts.retain(|a| a.relative_path != relative_path && a.name != artifact.name);
    index.artifacts.push(artifact.clone());
    save_index(&state, &index)?;

    Ok(artifact)
}

/// Delete a file or recursively delete a folder.
#[tauri::command]
pub fn delete_artifact(path: String, state: State<AppState>) -> Result<(), String> {
    let abs = resolve_relative(&state, &path)?;
    if abs == state.artifacts_dir {
        return Err("Cannot delete the artifacts root".to_string());
    }
    let metadata = std::fs::metadata(&abs).map_err(|e| format!("Not found: {}", e))?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&abs).map_err(|e| format!("Failed to remove folder: {}", e))?;
    } else {
        std::fs::remove_file(&abs).map_err(|e| format!("Failed to remove file: {}", e))?;
    }

    let removed_rel = rel_path_string(&state, &abs);
    let mut index = load_index(&state);
    let prefix_with_slash = format!("{}/", removed_rel);
    index.artifacts.retain(|a| {
        a.relative_path != removed_rel && !a.relative_path.starts_with(&prefix_with_slash)
    });
    save_index(&state, &index)?;

    Ok(())
}

#[tauri::command]
pub fn create_artifact_folder(path: String, state: State<AppState>) -> Result<Artifact, String> {
    let abs = resolve_relative(&state, &path)?;
    if abs == state.artifacts_dir {
        return Err("Path is the artifacts root".to_string());
    }
    if abs.exists() {
        return Err(format!("'{}' already exists", path));
    }
    std::fs::create_dir_all(&abs).map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(Artifact {
        name: abs.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string(),
        path: abs.to_string_lossy().to_string(),
        relative_path: rel_path_string(&state, &abs),
        size: 0,
        created_at: chrono::Local::now().to_rfc3339(),
        is_dir: true,
    })
}

/// Rename an artifact (file or folder) within its current parent directory.
/// `path` is the current relative path; `new_name` is the new basename only.
#[tauri::command]
pub fn rename_artifact(path: String, new_name: String, state: State<AppState>) -> Result<Artifact, String> {
    if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name == "." || new_name == ".." {
        return Err("Invalid name".to_string());
    }
    let abs_old = resolve_relative(&state, &path)?;
    if abs_old == state.artifacts_dir {
        return Err("Cannot rename the artifacts root".to_string());
    }
    let parent = abs_old.parent().ok_or("No parent directory")?;
    let abs_new = parent.join(&new_name);
    if abs_new.exists() {
        return Err(format!("'{}' already exists in this folder", new_name));
    }
    std::fs::rename(&abs_old, &abs_new).map_err(|e| format!("Rename failed: {}", e))?;

    let old_rel = rel_path_string(&state, &abs_old);
    let new_rel = rel_path_string(&state, &abs_new);
    let mut index = load_index(&state);
    let prefix_old = format!("{}/", old_rel);
    let prefix_new = format!("{}/", new_rel);
    for a in index.artifacts.iter_mut() {
        if a.relative_path == old_rel {
            a.relative_path = new_rel.clone();
            a.name = new_name.clone();
        } else if a.relative_path.starts_with(&prefix_old) {
            a.relative_path = format!("{}{}", prefix_new, &a.relative_path[prefix_old.len()..]);
        }
    }
    save_index(&state, &index)?;

    let metadata = std::fs::metadata(&abs_new).map_err(|e| e.to_string())?;
    Ok(Artifact {
        name: new_name,
        path: abs_new.to_string_lossy().to_string(),
        relative_path: new_rel,
        size: if metadata.is_dir() { 0 } else { metadata.len() },
        created_at: chrono::Local::now().to_rfc3339(),
        is_dir: metadata.is_dir(),
    })
}

/// Move an artifact (file or folder) into a different folder. `target_dir`
/// is relative to the artifacts root; empty string moves to the root.
#[tauri::command]
pub fn move_artifact(path: String, target_dir: String, state: State<AppState>) -> Result<Artifact, String> {
    let abs_src = resolve_relative(&state, &path)?;
    if abs_src == state.artifacts_dir {
        return Err("Cannot move the artifacts root".to_string());
    }
    let abs_target_dir = resolve_relative(&state, &target_dir)?;
    if !abs_target_dir.exists() || !abs_target_dir.is_dir() {
        return Err(format!("Target folder '{}' does not exist", target_dir));
    }
    if abs_src.parent() == Some(abs_target_dir.as_path()) {
        return Err("Already in that folder".to_string());
    }
    if abs_target_dir.starts_with(&abs_src) {
        return Err("Cannot move a folder into itself".to_string());
    }

    let name = abs_src.file_name().and_then(|n| n.to_str()).ok_or("Invalid source name")?.to_string();
    let abs_dst = abs_target_dir.join(&name);
    if abs_dst.exists() {
        return Err(format!("'{}' already exists in the target folder", name));
    }
    std::fs::rename(&abs_src, &abs_dst).map_err(|e| format!("Move failed: {}", e))?;

    let old_rel = rel_path_string(&state, &abs_src);
    let new_rel = rel_path_string(&state, &abs_dst);
    let mut index = load_index(&state);
    let prefix_old = format!("{}/", old_rel);
    let prefix_new = format!("{}/", new_rel);
    for a in index.artifacts.iter_mut() {
        if a.relative_path == old_rel {
            a.relative_path = new_rel.clone();
        } else if a.relative_path.starts_with(&prefix_old) {
            a.relative_path = format!("{}{}", prefix_new, &a.relative_path[prefix_old.len()..]);
        }
    }
    save_index(&state, &index)?;

    let metadata = std::fs::metadata(&abs_dst).map_err(|e| e.to_string())?;
    Ok(Artifact {
        name,
        path: abs_dst.to_string_lossy().to_string(),
        relative_path: new_rel,
        size: if metadata.is_dir() { 0 } else { metadata.len() },
        created_at: chrono::Local::now().to_rfc3339(),
        is_dir: metadata.is_dir(),
    })
}

/// Return the list of all directories under the artifacts root, depth-first.
/// Useful for the "move to..." picker. Includes the root as "".
#[tauri::command]
pub fn list_artifact_folders(state: State<AppState>) -> Vec<String> {
    let mut out: Vec<String> = vec![String::new()];
    walk_dirs(&state.artifacts_dir, &state.artifacts_dir, &mut out);
    out.sort();
    out
}

fn walk_dirs(root: &Path, current: &Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"));
            }
            walk_dirs(root, &path, out);
        }
    }
}
