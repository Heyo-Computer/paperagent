// Tiny typed localStorage helper for per-device view preferences (panel widths,
// collapse flags, column widths). These are intentionally NOT synced to the
// backend AgentConfig — they're ephemeral per-window UI state, and the app's
// deployed/remote modes shouldn't carry one device's pixel widths to another.

const PREFIX = "todo.ui.";

export function getPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setPref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore quota / disabled storage */
  }
}
