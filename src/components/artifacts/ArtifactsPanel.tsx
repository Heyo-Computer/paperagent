import { useEffect, useState } from "preact/hooks";
import { artifacts, allArtifacts } from "../../state/store";
import {
  listArtifacts,
  listAllArtifacts,
  deleteArtifact,
  readArtifact,
  saveArtifact,
  createArtifactFolder,
  renameArtifact,
  moveArtifact,
} from "../../api/commands";
import { ArtifactItem } from "./ArtifactItem";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import type { Artifact } from "../../types";

type ArtifactKind = "markdown" | "code" | "text" | "binary";

const CODE_EXTS = new Set([
  "js", "jsx", "ts", "tsx", "json", "py", "rs", "go", "rb", "java", "c", "h",
  "cpp", "hpp", "cs", "css", "scss", "html", "xml", "yaml", "yml", "toml",
  "sh", "bash", "sql", "swift", "kt", "php", "lua",
]);
const TEXT_EXTS = new Set(["txt", "log", "csv", "env", "ini", "conf"]);
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf", "zip", "gz",
  "tar", "wasm", "bin", "exe", "mp3", "mp4", "mov", "wav",
]);

function kindForName(name: string): ArtifactKind {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (BINARY_EXTS.has(ext)) return "binary";
  if (CODE_EXTS.has(ext)) return "code";
  if (TEXT_EXTS.has(ext)) return "text";
  // Default unknown/no-extension to text so it stays editable.
  return "text";
}

export function ArtifactsPanel() {
  const [cwd, setCwd] = useState<string>("");
  const [viewing, setViewing] = useState<Artifact | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadError, setLoadError] = useState<string>("");
  const [renaming, setRenaming] = useState<Artifact | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  const [creatingFolder, setCreatingFolder] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [actionError, setActionError] = useState<string>("");
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);

  function refresh(targetDir?: string) {
    const dir = targetDir ?? cwd;
    listArtifacts(dir)
      .then((items) => { artifacts.value = items; })
      .catch(() => { artifacts.value = []; });
    // Keep the flat @-mention list in sync with folder mutations.
    listAllArtifacts()
      .then((all) => { allArtifacts.value = all; })
      .catch(() => {});
  }

  useEffect(() => { refresh(cwd); }, [cwd]);

  useEffect(() => {
    setIsEditing(false);
    setDraft("");
    if (!viewing || viewing.is_dir) {
      setContent("");
      setLoadError("");
      return;
    }
    readArtifact(viewing.relative_path)
      .then((c) => { setContent(c); setLoadError(""); })
      .catch((e) => { setContent(""); setLoadError(`${e}`); });
  }, [viewing]);

  useEffect(() => {
    if (!viewing && !renaming && !creatingFolder) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (isEditing) { setIsEditing(false); setDraft(""); return; }
        setViewing(null);
        setRenaming(null);
        setCreatingFolder(false);
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [viewing, renaming, creatingFolder, isEditing]);

  async function handleDelete(item: Artifact) {
    if (!confirm(`Delete ${item.is_dir ? "folder" : "file"} "${item.name}"${item.is_dir ? " and everything inside it" : ""}?`)) return;
    try {
      await deleteArtifact(item.relative_path);
      if (viewing?.relative_path === item.relative_path) setViewing(null);
      refresh();
    } catch (e) {
      setActionError(`${e}`);
    }
  }

  function handleEnter(item: Artifact) {
    if (item.is_dir) {
      setCwd(item.relative_path);
    } else {
      setViewing(item);
    }
  }

  function openRename(item: Artifact) {
    setRenaming(item);
    setRenameValue(item.name);
    setActionError("");
  }

  async function submitRename() {
    if (!renaming || !renameValue.trim()) return;
    try {
      await renameArtifact(renaming.relative_path, renameValue.trim());
      setRenaming(null);
      refresh();
    } catch (e) {
      setActionError(`${e}`);
    }
  }

  async function doMove(sourcePath: string, targetDir: string) {
    setActionError("");
    try {
      await moveArtifact(sourcePath, targetDir);
      refresh();
    } catch (e) {
      setActionError(`${e}`);
    }
  }

  async function submitNewFolder() {
    if (!newFolderName.trim()) return;
    try {
      await createArtifactFolder(cwd ? `${cwd}/${newFolderName.trim()}` : newFolderName.trim());
      setCreatingFolder(false);
      setNewFolderName("");
      refresh();
    } catch (e) {
      setActionError(`${e}`);
    }
  }

  function handleBreadcrumbDragOver(e: DragEvent, seg: string) {
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes("application/x-artifact-path")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragTarget(`breadcrumb:${seg}`);
  }

  function handleBreadcrumbDrop(e: DragEvent, seg: string) {
    const source = e.dataTransfer?.getData("application/x-artifact-path");
    setDragTarget(null);
    if (!source) return;
    e.preventDefault();
    doMove(source, seg);
  }

  const viewKind = viewing ? kindForName(viewing.name) : "binary";
  const canEdit = !!viewing && !viewing.is_dir && viewKind !== "binary" && !loadError;

  async function handleSave() {
    if (!viewing) return;
    setSaving(true);
    try {
      await saveArtifact(viewing.relative_path, draft);
      setContent(draft);
      setIsEditing(false);
      refresh();
    } catch (e) {
      setLoadError(`${e}`);
    } finally {
      setSaving(false);
    }
  }

  const breadcrumbs = ["", ...cwd.split("/").filter(Boolean).map((_, i, arr) => arr.slice(0, i + 1).join("/"))];

  return (
    <>
      <div class="artifacts-toolbar">
        <div class="artifacts-breadcrumbs">
          {breadcrumbs.map((seg, i) => {
            const isDropping = dragTarget === `breadcrumb:${seg}`;
            return (
              <span key={seg}>
                {i > 0 && <span class="artifacts-breadcrumb-sep">/</span>}
                <button
                  class={`artifacts-breadcrumb${isDropping ? " artifacts-breadcrumb-drop" : ""}`}
                  onClick={() => setCwd(seg)}
                  disabled={seg === cwd}
                  onDragOver={(e) => handleBreadcrumbDragOver(e, seg)}
                  onDragLeave={() => setDragTarget(null)}
                  onDrop={(e) => handleBreadcrumbDrop(e, seg)}
                >
                  {seg === "" ? "artifacts" : seg.split("/").pop()}
                </button>
              </span>
            );
          })}
        </div>
        <button
          class="btn btn-sm btn-ghost"
          onClick={() => { setCreatingFolder(true); setNewFolderName(""); setActionError(""); }}
          title="New folder"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
      </div>

      {creatingFolder && (
        <div class="artifacts-inline-form">
          <input
            type="text"
            class="settings-input"
            placeholder="Folder name"
            value={newFolderName}
            onInput={(e) => setNewFolderName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNewFolder();
              if (e.key === "Escape") setCreatingFolder(false);
            }}
            autoFocus
          />
          <button class="btn btn-sm btn-primary" onClick={submitNewFolder}>Create</button>
          <button class="btn btn-sm btn-ghost" onClick={() => setCreatingFolder(false)}>Cancel</button>
        </div>
      )}

      {isDragging && (
        <div class="artifacts-drag-hint">Drop on a folder or breadcrumb to move</div>
      )}

      {actionError && <div class="status-error" style={{ margin: "6px 12px" }}>{actionError}</div>}

      {artifacts.value.length === 0 && !creatingFolder ? (
        <div class="empty-state" style={{ paddingTop: "40px" }}>
          <div class="empty-state-text">
            {cwd ? "This folder is empty." : "No artifacts yet. The agent can save files here for reuse."}
          </div>
        </div>
      ) : (
        <div class="artifacts-panel">
          {artifacts.value.map((artifact) => (
            <ArtifactItem
              key={artifact.relative_path}
              artifact={artifact}
              onDelete={() => handleDelete(artifact)}
              onView={() => handleEnter(artifact)}
              onRename={() => openRename(artifact)}
              onDrop={(source) => doMove(source, artifact.relative_path)}
              onDragStateChange={(active) => setIsDragging(active)}
            />
          ))}
        </div>
      )}

      {viewing && !viewing.is_dir && (
        <div class="artifact-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setViewing(null); }}>
          <div class="artifact-modal">
            <div class="artifact-modal-header">
              <span class="artifact-modal-title">{viewing.name}</span>
              <div class="artifact-modal-actions">
                {isEditing ? (
                  <>
                    <button class="btn btn-sm btn-primary" onClick={handleSave} disabled={saving}>
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button class="btn btn-sm btn-ghost" onClick={() => { setIsEditing(false); setDraft(""); }} disabled={saving}>
                      Cancel
                    </button>
                  </>
                ) : (
                  canEdit && (
                    <button class="btn btn-sm btn-ghost" onClick={() => { setDraft(content); setIsEditing(true); }}>
                      Edit
                    </button>
                  )
                )}
                <button class="settings-close" onClick={() => setViewing(null)} title="Close">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
              </div>
            </div>
            <div class="artifact-modal-body">
              {loadError ? (
                <div class="status-error">{loadError}</div>
              ) : isEditing ? (
                <textarea
                  class={`artifact-editor${viewKind === "code" ? " artifact-editor-code" : ""}`}
                  value={draft}
                  spellcheck={viewKind !== "code"}
                  onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
                  onKeyDown={(e) => {
                    if (viewKind === "code" && e.key === "Tab") {
                      e.preventDefault();
                      const ta = e.target as HTMLTextAreaElement;
                      const start = ta.selectionStart, end = ta.selectionEnd;
                      const next = draft.slice(0, start) + "  " + draft.slice(end);
                      setDraft(next);
                      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
                    }
                  }}
                  autoFocus
                />
              ) : viewKind === "markdown" ? (
                <MarkdownRenderer content={content} />
              ) : (
                <pre class={`artifact-plain${viewKind === "code" ? " artifact-code" : ""}`}>{content}</pre>
              )}
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div class="artifact-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setRenaming(null); }}>
          <div class="artifact-modal" style={{ maxWidth: "360px" }}>
            <div class="artifact-modal-header">
              <span class="artifact-modal-title">Rename "{renaming.name}"</span>
              <button class="settings-close" onClick={() => setRenaming(null)} title="Close">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            </div>
            <div class="artifact-modal-body">
              <input
                type="text"
                class="settings-input"
                value={renameValue}
                onInput={(e) => setRenameValue((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitRename(); }}
                autoFocus
              />
              <div class="status-actions" style={{ marginTop: "8px" }}>
                <button class="btn btn-sm btn-primary" onClick={submitRename}>Rename</button>
                <button class="btn btn-sm btn-ghost" onClick={() => setRenaming(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
