import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const DATA_ROOT = "/data";

/** Format a Date as YYYY-MM-DD in local time (not UTC). */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface LinkRef {
  kind: "list" | "book";
  target_id: string;
  sub_id: string;
  label?: string;
}

interface TodoItem {
  id: string;
  title: string;
  completed: boolean;
  has_spec: boolean;
  links?: LinkRef[];
  created_at: string;
  updated_at: string;
}

interface DayEntry {
  date: string;
  todos: TodoItem[];
}

function dayDir(date: string): string {
  const [y, m, d] = date.split("-");
  return path.join(DATA_ROOT, "storage", y, m, d);
}

const BACKLOG_PATH = path.join(DATA_ROOT, "storage", "backlog.json");
const BACKLOG_SPECS_DIR = path.join(DATA_ROOT, "storage", "backlog", "specs");

interface Backlog {
  items: TodoItem[];
}

function loadBacklogFile(): Backlog {
  if (fs.existsSync(BACKLOG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(BACKLOG_PATH, "utf-8"));
      const items = (raw.items ?? []).map((t: TodoItem) => ({
        ...t,
        created_at: t.created_at || "",
        updated_at: t.updated_at || "",
        has_spec: t.has_spec ?? false,
        links: t.links ?? [],
      }));
      return { items };
    } catch {}
  }
  return { items: [] };
}

function saveBacklogFile(backlog: Backlog): void {
  fs.mkdirSync(path.dirname(BACKLOG_PATH), { recursive: true });
  fs.writeFileSync(BACKLOG_PATH, JSON.stringify(backlog, null, 2), "utf-8");
}

function loadDay(date: string): DayEntry {
  const file = path.join(dayDir(date), "day.json");
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    // Ensure date is always set (old files may lack it)
    raw.date = raw.date || date;
    // Backfill missing timestamp fields on old todos
    for (const t of raw.todos ?? []) {
      t.created_at = t.created_at || "";
      t.updated_at = t.updated_at || "";
      t.has_spec = t.has_spec ?? false;
      t.links = t.links ?? [];
    }
    return raw;
  }
  return { date, todos: [] };
}

function saveDay(entry: DayEntry): void {
  const dir = dayDir(entry.date);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "day.json"), JSON.stringify(entry, null, 2), "utf-8");
}

export function saveTodoSpec(date: string, todoId: string, content: string): string {
  const entry = loadDay(date);
  const todo = entry.todos.find((t) => t.id === todoId);
  if (!todo) {
    return `Error: todo ${todoId} not found on ${date}`;
  }

  // Write spec file
  const specsDir = path.join(dayDir(date), "specs");
  fs.mkdirSync(specsDir, { recursive: true });
  const specPath = path.join(specsDir, `${todoId}.md`);
  fs.writeFileSync(specPath, content, "utf-8");

  // Mark has_spec on the todo
  todo.has_spec = true;
  todo.updated_at = new Date().toISOString();
  saveDay(entry);

  return `Saved spec for "${todo.title}" (${content.length} bytes)`;
}

export function updateTodo(
  date: string,
  todoId: string,
  title?: string,
  completed?: boolean,
): string {
  const entry = loadDay(date);
  const todo = entry.todos.find((t) => t.id === todoId);
  if (!todo) {
    return `Error: todo ${todoId} not found on ${date}`;
  }

  if (title !== undefined) todo.title = title;
  if (completed !== undefined) todo.completed = completed;
  todo.updated_at = new Date().toISOString();
  saveDay(entry);

  return `Updated "${todo.title}" (completed=${todo.completed})`;
}

export function addTodo(date: string, title: string): DayEntry {
  const entry = loadDay(date);
  const now = new Date().toISOString();
  entry.todos.push({
    id: randomUUID(),
    title,
    completed: false,
    has_spec: false,
    links: [],
    created_at: now,
    updated_at: now,
  });
  saveDay(entry);
  return entry;
}

export function deleteTodo(date: string, todoId: string): DayEntry {
  const entry = loadDay(date);
  const specPath = path.join(dayDir(date), "specs", `${todoId}.md`);
  entry.todos = entry.todos.filter((t) => t.id !== todoId);
  try { fs.unlinkSync(specPath); } catch {}
  saveDay(entry);
  return entry;
}

export function loadDayEntry(date: string): DayEntry {
  return loadDay(date);
}

export function loadDaysRange(offsetStart: number = -6, offsetEnd: number = 1): DayEntry[] {
  const today = new Date();
  const entries: DayEntry[] = [];
  for (let i = offsetStart; i <= offsetEnd; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = localDateStr(d);
    entries.push(loadDay(dateStr));
  }
  return entries;
}

export function loadSpecContent(date: string, todoId: string): string {
  const specPath = path.join(dayDir(date), "specs", `${todoId}.md`);
  try {
    return fs.readFileSync(specPath, "utf-8");
  } catch {
    return "";
  }
}

export function updateTodoEntry(date: string, todo: TodoItem): DayEntry {
  const entry = loadDay(date);
  const existing = entry.todos.find((t) => t.id === todo.id);
  if (existing) {
    existing.title = todo.title;
    existing.completed = todo.completed;
    existing.has_spec = todo.has_spec;
    existing.updated_at = new Date().toISOString();
  }
  saveDay(entry);
  return entry;
}

export function loadBacklog(): Backlog {
  return loadBacklogFile();
}

export function addBacklogItem(title: string): Backlog {
  const backlog = loadBacklogFile();
  const now = new Date().toISOString();
  backlog.items.push({
    id: randomUUID(),
    title,
    completed: false,
    has_spec: false,
    links: [],
    created_at: now,
    updated_at: now,
  });
  saveBacklogFile(backlog);
  return backlog;
}

export function updateBacklogEntry(item: TodoItem): Backlog {
  const backlog = loadBacklogFile();
  const existing = backlog.items.find((t) => t.id === item.id);
  if (existing) {
    existing.title = item.title;
    existing.completed = item.completed;
    existing.has_spec = item.has_spec;
    existing.updated_at = new Date().toISOString();
  }
  saveBacklogFile(backlog);
  return backlog;
}

export function deleteBacklogItem(itemId: string): Backlog {
  const backlog = loadBacklogFile();
  backlog.items = backlog.items.filter((t) => t.id !== itemId);
  try { fs.unlinkSync(path.join(BACKLOG_SPECS_DIR, `${itemId}.md`)); } catch {}
  saveBacklogFile(backlog);
  return backlog;
}

export function loadBacklogSpec(itemId: string): string {
  try {
    return fs.readFileSync(path.join(BACKLOG_SPECS_DIR, `${itemId}.md`), "utf-8");
  } catch {
    return "";
  }
}

export function saveBacklogSpecContent(itemId: string, content: string): void {
  fs.mkdirSync(BACKLOG_SPECS_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKLOG_SPECS_DIR, `${itemId}.md`), content, "utf-8");
  const backlog = loadBacklogFile();
  const item = backlog.items.find((t) => t.id === itemId);
  if (item) {
    item.has_spec = true;
    item.updated_at = new Date().toISOString();
  }
  saveBacklogFile(backlog);
}

export function moveBacklogToDay(itemId: string, date: string): { backlog: Backlog; day: DayEntry } {
  const backlog = loadBacklogFile();
  const idx = backlog.items.findIndex((t) => t.id === itemId);
  if (idx < 0) {
    throw new Error(`backlog item ${itemId} not found`);
  }
  const item = backlog.items.splice(idx, 1)[0];
  item.updated_at = new Date().toISOString();

  if (item.has_spec) {
    const src = path.join(BACKLOG_SPECS_DIR, `${itemId}.md`);
    if (fs.existsSync(src)) {
      const dstDir = path.join(dayDir(date), "specs");
      fs.mkdirSync(dstDir, { recursive: true });
      fs.renameSync(src, path.join(dstDir, `${itemId}.md`));
    }
  }

  const day = loadDay(date);
  day.todos.push(item);
  saveDay(day);
  saveBacklogFile(backlog);
  return { backlog, day };
}

export function getBacklogText(): string {
  const backlog = loadBacklogFile();
  if (backlog.items.length === 0) {
    return "Backlog is empty.";
  }
  return backlog.items
    .map((t) => {
      const status = t.completed ? "[x]" : "[ ]";
      const spec = t.has_spec ? " (has spec)" : "";
      return `${status} ${t.title}\n    id: ${t.id}${spec}`;
    })
    .join("\n");
}

export function getTodosForDate(date?: string): string {
  const d = date || localDateStr(new Date());
  const entry = loadDay(d);

  if (entry.todos.length === 0) {
    return `No todos for ${d}`;
  }

  return entry.todos
    .map((t) => {
      const status = t.completed ? "[x]" : "[ ]";
      const spec = t.has_spec ? " (has spec)" : "";
      return `${status} ${t.title}\n    id: ${t.id}${spec}`;
    })
    .join("\n");
}

// ── Links (bidirectional todo <-> list item / book page, T-009) ──

/** Add an outgoing link onto a todo (deduped). `date` empty → backlog item.
 * Returns the todo's title so callers can label the reverse reference. */
export function addLinkToTodo(date: string, todoId: string, link: LinkRef): string {
  const matches = (l: LinkRef) =>
    l.kind === link.kind && l.target_id === link.target_id && l.sub_id === link.sub_id;
  if (!date) {
    const backlog = loadBacklogFile();
    const todo = backlog.items.find((t) => t.id === todoId);
    if (!todo) throw new Error(`todo ${todoId} not found in backlog`);
    todo.links = todo.links ?? [];
    if (!todo.links.some(matches)) {
      todo.links.push(link);
      todo.updated_at = new Date().toISOString();
    }
    saveBacklogFile(backlog);
    return todo.title;
  }
  const entry = loadDay(date);
  const todo = entry.todos.find((t) => t.id === todoId);
  if (!todo) throw new Error(`todo ${todoId} not found on ${date}`);
  todo.links = todo.links ?? [];
  if (!todo.links.some(matches)) {
    todo.links.push(link);
    todo.updated_at = new Date().toISOString();
  }
  saveDay(entry);
  return todo.title;
}

/** Remove the matching outgoing link from a todo. `date` empty → backlog item. */
export function removeLinkFromTodo(
  date: string,
  todoId: string,
  kind: "list" | "book",
  targetId: string,
  subId: string,
): void {
  const keep = (l: LinkRef) =>
    !(l.kind === kind && l.target_id === targetId && l.sub_id === subId);
  if (!date) {
    const backlog = loadBacklogFile();
    const todo = backlog.items.find((t) => t.id === todoId);
    if (todo) {
      todo.links = (todo.links ?? []).filter(keep);
      todo.updated_at = new Date().toISOString();
    }
    saveBacklogFile(backlog);
    return;
  }
  const entry = loadDay(date);
  const todo = entry.todos.find((t) => t.id === todoId);
  if (todo) {
    todo.links = (todo.links ?? []).filter(keep);
    todo.updated_at = new Date().toISOString();
  }
  saveDay(entry);
}
