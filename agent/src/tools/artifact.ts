import * as fs from "node:fs";
import * as path from "node:path";
import { ARTIFACTS_DIR } from "./paths.js";

const INDEX_FILE = path.join(ARTIFACTS_DIR, ".index.json");

// Mirrors the Rust `Artifact` model (src-tauri/src/models/artifact.rs): a folder
// tree under /data/artifacts, with a `.index.json` that records created_at per
// relative path. `path` is the absolute (/data/...) path; `relative_path` uses
// `/` separators and is "" for the root.
export interface Artifact {
  name: string;
  path: string;
  relative_path: string;
  size: number;
  created_at: string;
  is_dir: boolean;
}

interface ArtifactIndex {
  artifacts: Artifact[];
}

function loadIndex(): ArtifactIndex {
  if (!fs.existsSync(INDEX_FILE)) return { artifacts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, "utf-8"));
    if (!parsed || !Array.isArray(parsed.artifacts)) return { artifacts: [] };
    return parsed as ArtifactIndex;
  } catch {
    return { artifacts: [] };
  }
}

function saveIndex(index: ArtifactIndex): void {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");
}

/** Resolve a relative path against the artifacts root, rejecting `..`/absolute. */
function resolveRelative(rel: string): string {
  if (rel.includes("\0")) throw new Error("Invalid path: NUL byte");
  const segments = rel.split(/[/\\]/).filter((s) => s.length > 0 && s !== ".");
  for (const seg of segments) {
    if (seg === "..") throw new Error(`Invalid path '${rel}': only relative segments allowed`);
  }
  return path.join(ARTIFACTS_DIR, ...segments);
}

function relPathString(abs: string): string {
  const rel = path.relative(ARTIFACTS_DIR, abs);
  return rel.split(path.sep).join("/");
}

function entryToArtifact(abs: string, lookup: Map<string, string>): Artifact | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  const name = path.basename(abs);
  if (name.startsWith(".")) return null;
  const relative_path = relPathString(abs);
  const created_at = lookup.get(relative_path) ?? stat.mtime.toISOString();
  return {
    name,
    path: abs,
    relative_path,
    size: stat.isDirectory() ? 0 : stat.size,
    created_at,
    is_dir: stat.isDirectory(),
  };
}

function indexLookup(): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const a of loadIndex().artifacts) lookup.set(a.relative_path, a.created_at);
  return lookup;
}

// ── RPC surface (mirrors src-tauri/src/commands/artifacts.rs) ──

/** List entries directly inside `dir` (relative; "" = root). Folders first
 * (name asc), then files (newest-first). */
export function listArtifactsIn(dir = ""): Artifact[] {
  let absDir: string;
  try {
    absDir = resolveRelative(dir);
  } catch {
    return [];
  }
  if (!fs.existsSync(absDir)) return [];
  const lookup = indexLookup();
  const folders: Artifact[] = [];
  const files: Artifact[] = [];
  for (const name of fs.readdirSync(absDir)) {
    const a = entryToArtifact(path.join(absDir, name), lookup);
    if (!a) continue;
    (a.is_dir ? folders : files).push(a);
  }
  folders.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  files.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [...folders, ...files];
}

/** Recursively list every file and folder under the root, flattened. */
export function listAllArtifacts(): Artifact[] {
  const lookup = indexLookup();
  const folders: Artifact[] = [];
  const files: Artifact[] = [];
  const walk = (current: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = path.join(current, name);
      const a = entryToArtifact(abs, lookup);
      if (!a) continue;
      if (a.is_dir) {
        folders.push(a);
        walk(abs);
      } else {
        files.push(a);
      }
    }
  };
  walk(ARTIFACTS_DIR);
  folders.sort((a, b) => a.relative_path.toLowerCase().localeCompare(b.relative_path.toLowerCase()));
  files.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [...folders, ...files];
}

export function readArtifactFile(rel: string): string {
  return fs.readFileSync(resolveRelative(rel), "utf-8");
}

/** Save a file; `rel` may include subdirectories (parents auto-created). */
export function saveArtifactFile(rel: string, content: string): Artifact {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const abs = resolveRelative(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");

  const relative_path = relPathString(abs);
  const artifact: Artifact = {
    name: path.basename(abs),
    path: abs,
    relative_path,
    size: fs.statSync(abs).size,
    created_at: new Date().toISOString(),
    is_dir: false,
  };
  const index = loadIndex();
  index.artifacts = index.artifacts.filter(
    (a) => a.relative_path !== relative_path && a.name !== artifact.name,
  );
  index.artifacts.push(artifact);
  saveIndex(index);
  return artifact;
}

/** Delete a file, or recursively delete a folder. */
export function deleteArtifactPath(rel: string): void {
  const abs = resolveRelative(rel);
  if (abs === ARTIFACTS_DIR) throw new Error("Cannot delete the artifacts root");
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
  else fs.unlinkSync(abs);

  const removedRel = relPathString(abs);
  const prefix = `${removedRel}/`;
  const index = loadIndex();
  index.artifacts = index.artifacts.filter(
    (a) => a.relative_path !== removedRel && !a.relative_path.startsWith(prefix),
  );
  saveIndex(index);
}

export function createArtifactFolder(rel: string): Artifact {
  const abs = resolveRelative(rel);
  if (abs === ARTIFACTS_DIR) throw new Error("Path is the artifacts root");
  if (fs.existsSync(abs)) throw new Error(`'${rel}' already exists`);
  fs.mkdirSync(abs, { recursive: true });
  return {
    name: path.basename(abs),
    path: abs,
    relative_path: relPathString(abs),
    size: 0,
    created_at: new Date().toISOString(),
    is_dir: true,
  };
}

/** Re-point index entries when a path (or its subtree) moves/renames. */
function repointIndex(oldRel: string, newRel: string, renameLeaf: string | null): void {
  const prefixOld = `${oldRel}/`;
  const prefixNew = `${newRel}/`;
  const index = loadIndex();
  for (const a of index.artifacts) {
    if (a.relative_path === oldRel) {
      a.relative_path = newRel;
      if (renameLeaf) a.name = renameLeaf;
    } else if (a.relative_path.startsWith(prefixOld)) {
      a.relative_path = prefixNew + a.relative_path.slice(prefixOld.length);
    }
  }
  saveIndex(index);
}

export function renameArtifactPath(rel: string, newName: string): Artifact {
  if (!newName || newName.includes("/") || newName.includes("\\") || newName === "." || newName === "..") {
    throw new Error("Invalid name");
  }
  const absOld = resolveRelative(rel);
  if (absOld === ARTIFACTS_DIR) throw new Error("Cannot rename the artifacts root");
  const absNew = path.join(path.dirname(absOld), newName);
  if (fs.existsSync(absNew)) throw new Error(`'${newName}' already exists in this folder`);
  fs.renameSync(absOld, absNew);
  repointIndex(relPathString(absOld), relPathString(absNew), newName);
  const stat = fs.statSync(absNew);
  return {
    name: newName,
    path: absNew,
    relative_path: relPathString(absNew),
    size: stat.isDirectory() ? 0 : stat.size,
    created_at: new Date().toISOString(),
    is_dir: stat.isDirectory(),
  };
}

export function moveArtifactPath(rel: string, targetDir: string): Artifact {
  const absSrc = resolveRelative(rel);
  if (absSrc === ARTIFACTS_DIR) throw new Error("Cannot move the artifacts root");
  const absTargetDir = resolveRelative(targetDir);
  if (!fs.existsSync(absTargetDir) || !fs.statSync(absTargetDir).isDirectory()) {
    throw new Error(`Target folder '${targetDir}' does not exist`);
  }
  if (path.dirname(absSrc) === absTargetDir) throw new Error("Already in that folder");
  if (absTargetDir === absSrc || absTargetDir.startsWith(`${absSrc}${path.sep}`)) {
    throw new Error("Cannot move a folder into itself");
  }
  const name = path.basename(absSrc);
  const absDst = path.join(absTargetDir, name);
  if (fs.existsSync(absDst)) throw new Error(`'${name}' already exists in the target folder`);
  fs.renameSync(absSrc, absDst);
  repointIndex(relPathString(absSrc), relPathString(absDst), null);
  const stat = fs.statSync(absDst);
  return {
    name,
    path: absDst,
    relative_path: relPathString(absDst),
    size: stat.isDirectory() ? 0 : stat.size,
    created_at: new Date().toISOString(),
    is_dir: stat.isDirectory(),
  };
}

/** All directories under the root, depth-first; includes the root as "". */
export function listArtifactFolders(): string[] {
  const out: string[] = [""];
  const walk = (current: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const abs = path.join(current, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        out.push(relPathString(abs));
        walk(abs);
      }
    }
  };
  walk(ARTIFACTS_DIR);
  out.sort();
  return out;
}

// ── AI-tool helpers (kept for agent.ts's save_artifact / list_artifacts tools) ──

export function saveArtifact(name: string, content: string): string {
  if (!name || name.includes("/") || name.includes("..")) {
    return `Error: invalid artifact name '${name}'. Use a plain filename like 'script.sh' or 'notes.md'.`;
  }
  const a = saveArtifactFile(name, content);
  return `Saved artifact '${a.name}' (${a.size} bytes)`;
}

export function listArtifacts(): string {
  const files = listAllArtifacts().filter((a) => !a.is_dir);
  if (files.length === 0) return "No artifacts saved yet.";
  return files.map((a) => `${a.relative_path} (${a.size} bytes, ${a.created_at})`).join("\n");
}
