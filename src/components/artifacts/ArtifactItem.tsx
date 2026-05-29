import { useState } from "preact/hooks";
import { openPath } from "@tauri-apps/plugin-opener";
import type { Artifact } from "../../types";

interface ArtifactItemProps {
  artifact: Artifact;
  onDelete: () => void;
  onView: () => void;
  onRename: () => void;
  onDrop: (sourcePath: string) => void;
  onDragStateChange: (active: boolean) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(artifact: Artifact): string {
  if (artifact.is_dir) return "\u{1F4C2}";
  const ext = artifact.name.split(".").pop()?.toLowerCase() ?? "";
  const icons: Record<string, string> = {
    md: "\u{1F4DD}",
    txt: "\u{1F4C4}",
    json: "\u{1F4CB}",
    js: "\u{1F4DC}",
    ts: "\u{1F4DC}",
    py: "\u{1F40D}",
    rs: "\u{2699}",
    html: "\u{1F310}",
    css: "\u{1F3A8}",
    png: "\u{1F5BC}",
    jpg: "\u{1F5BC}",
    svg: "\u{1F5BC}",
  };
  return icons[ext] ?? "\u{1F4C1}";
}

export function ArtifactItem({ artifact, onDelete, onView, onRename, onDrop, onDragStateChange }: ArtifactItemProps) {
  const [hoverDrop, setHoverDrop] = useState(false);

  async function handleOpenWith(e: Event) {
    e.stopPropagation();
    try {
      await openPath(artifact.path);
    } catch (err) {
      console.error("openPath failed", err);
    }
  }

  function handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData("application/x-artifact-path", artifact.relative_path);
    e.dataTransfer.effectAllowed = "move";

    // The default drag image is the rendered element, which is full-width
    // because the row stretches to the panel. Build a compact pill instead.
    const ghost = document.createElement("div");
    ghost.className = "artifact-drag-ghost";
    ghost.textContent = `${artifact.is_dir ? "\u{1F4C2}" : "\u{1F4C4}"}  ${artifact.name}`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    // The browser snapshots the element synchronously, so we can remove it
    // immediately after the current task.
    setTimeout(() => ghost.remove(), 0);

    onDragStateChange(true);
  }

  function handleDragEnd() {
    onDragStateChange(false);
    setHoverDrop(false);
  }

  function handleDragOver(e: DragEvent) {
    if (!artifact.is_dir) return;
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes("application/x-artifact-path")) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (!hoverDrop) setHoverDrop(true);
  }

  function handleDragLeave() {
    if (hoverDrop) setHoverDrop(false);
  }

  function handleDrop(e: DragEvent) {
    if (!artifact.is_dir) return;
    const source = e.dataTransfer?.getData("application/x-artifact-path");
    setHoverDrop(false);
    if (!source) return;
    e.preventDefault();
    e.stopPropagation();
    if (source === artifact.relative_path) return;
    onDrop(source);
  }

  const itemClass = `artifact-item${hoverDrop ? " artifact-item-drop" : ""}`;

  return (
    <div
      class={itemClass}
      onClick={onView}
      style={{ cursor: "pointer" }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      title={artifact.is_dir ? "Drag files here to move them in" : "Drag to a folder to move"}
    >
      <div class="artifact-icon">{getFileIcon(artifact)}</div>
      <div class="artifact-info">
        <div class="artifact-name">{artifact.name}</div>
        <div class="artifact-meta">{artifact.is_dir ? "Folder" : formatSize(artifact.size)}</div>
      </div>
      <button
        class="btn btn-sm btn-ghost"
        onClick={(e) => { e.stopPropagation(); onRename(); }}
        title="Rename"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      </button>
      {!artifact.is_dir && (
        <button
          class="btn btn-sm btn-ghost"
          onClick={handleOpenWith}
          title="Open with default app"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </button>
      )}
      <button
        class="btn btn-sm btn-ghost"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          <path d="M10 11v6" /><path d="M14 11v6" />
        </svg>
      </button>
    </div>
  );
}
