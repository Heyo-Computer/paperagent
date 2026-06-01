import * as fs from "node:fs";
import * as path from "node:path";
import { saveList, upsertListIndex, loadListsIndex, getList } from "./lists.js";
import type { List } from "./lists.js";
import { saveBook, upsertBookIndex, savePage, loadBooksIndex, loadBook, loadPage } from "./books.js";
import type { Book } from "./books.js";
import { saveArtifactFile, listAllArtifacts, readArtifactFile } from "./artifact.js";
import { STORAGE_DIR } from "./paths.js";

// Bulk import of a full local snapshot into the sandbox's /data/storage. The
// host (Rust) reads its local files and ships them here so a fresh/cloud sandbox
// can be seeded. Merge policy: overwrite-by-id (days/backlog merge todos by id;
// lists/books/artifacts overwrite the whole entity).

const STORAGE_ROOT = STORAGE_DIR;
const BACKLOG_PATH = path.join(STORAGE_ROOT, "backlog.json");
const BACKLOG_SPECS_DIR = path.join(STORAGE_ROOT, "backlog", "specs");

interface TodoLike {
  id: string;
  [k: string]: unknown;
}

export interface MigrationBundle {
  days?: { date: string; todos: TodoLike[]; specs?: Record<string, string> }[];
  backlog?: { items: TodoLike[]; specs?: Record<string, string> };
  lists?: List[];
  books?: { book: Book; pages?: Record<string, string> }[];
  artifacts?: { path: string; content: string }[];
}

export interface MigrationStats {
  days: number;
  todos: number;
  backlog: number;
  lists: number;
  books: number;
  artifacts: number;
}

function dayDir(date: string): string {
  const [y, m, d] = date.split("-");
  return path.join(STORAGE_ROOT, y, m, d);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function mergeById(existing: TodoLike[], incoming: TodoLike[]): TodoLike[] {
  const byId = new Map<string, TodoLike>();
  for (const t of existing) byId.set(t.id, t);
  for (const t of incoming) byId.set(t.id, t);
  return [...byId.values()];
}

function importDay(day: NonNullable<MigrationBundle["days"]>[number]): void {
  const dir = dayDir(day.date);
  const file = path.join(dir, "day.json");
  const existing = fs.existsSync(file)
    ? readJson<{ date: string; todos: TodoLike[] }>(file, { date: day.date, todos: [] })
    : { date: day.date, todos: [] };
  const merged = { date: day.date, todos: mergeById(existing.todos ?? [], day.todos ?? []) };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2), "utf-8");
  if (day.specs) {
    const specsDir = path.join(dir, "specs");
    fs.mkdirSync(specsDir, { recursive: true });
    for (const [id, content] of Object.entries(day.specs)) {
      fs.writeFileSync(path.join(specsDir, `${id}.md`), content, "utf-8");
    }
  }
}

function importBacklog(backlog: NonNullable<MigrationBundle["backlog"]>): void {
  const existing = fs.existsSync(BACKLOG_PATH)
    ? readJson<{ items: TodoLike[] }>(BACKLOG_PATH, { items: [] })
    : { items: [] };
  const merged = { items: mergeById(existing.items ?? [], backlog.items ?? []) };
  fs.mkdirSync(path.dirname(BACKLOG_PATH), { recursive: true });
  fs.writeFileSync(BACKLOG_PATH, JSON.stringify(merged, null, 2), "utf-8");
  if (backlog.specs) {
    fs.mkdirSync(BACKLOG_SPECS_DIR, { recursive: true });
    for (const [id, content] of Object.entries(backlog.specs)) {
      fs.writeFileSync(path.join(BACKLOG_SPECS_DIR, `${id}.md`), content, "utf-8");
    }
  }
}

export function importBundle(bundle: MigrationBundle): MigrationStats {
  const imported: MigrationStats = { days: 0, todos: 0, backlog: 0, lists: 0, books: 0, artifacts: 0 };

  for (const day of bundle.days ?? []) {
    importDay(day);
    imported.days += 1;
    imported.todos += day.todos?.length ?? 0;
  }

  if (bundle.backlog) {
    importBacklog(bundle.backlog);
    imported.backlog += bundle.backlog.items?.length ?? 0;
  }

  for (const list of bundle.lists ?? []) {
    saveList(list);
    upsertListIndex(list);
    imported.lists += 1;
  }

  for (const entry of bundle.books ?? []) {
    saveBook(entry.book);
    upsertBookIndex(entry.book);
    for (const [pageId, content] of Object.entries(entry.pages ?? {})) {
      savePage(entry.book.id, pageId, content);
    }
    imported.books += 1;
  }

  for (const a of bundle.artifacts ?? []) {
    saveArtifactFile(a.path, a.content);
    imported.artifacts += 1;
  }

  return imported;
}

/** Count what currently lives in the sandbox (drives the migration prompt). */
export function migrationStats(): MigrationStats {
  const stats: MigrationStats = { days: 0, todos: 0, backlog: 0, lists: 0, books: 0, artifacts: 0 };

  // Walk /data/storage/YYYY/MM/DD/day.json
  const isNum = (s: string) => /^\d+$/.test(s);
  const safeReaddir = (dir: string) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [] as string[];
    }
  };
  for (const y of safeReaddir(STORAGE_ROOT).filter((n) => isNum(n) && n.length === 4)) {
    const yDir = path.join(STORAGE_ROOT, y);
    for (const m of safeReaddir(yDir).filter(isNum)) {
      const mDir = path.join(yDir, m);
      for (const d of safeReaddir(mDir).filter(isNum)) {
        const file = path.join(mDir, d, "day.json");
        if (!fs.existsSync(file)) continue;
        const entry = readJson<{ todos: TodoLike[] }>(file, { todos: [] });
        stats.days += 1;
        stats.todos += entry.todos?.length ?? 0;
      }
    }
  }

  stats.backlog = fs.existsSync(BACKLOG_PATH)
    ? readJson<{ items: TodoLike[] }>(BACKLOG_PATH, { items: [] }).items?.length ?? 0
    : 0;
  stats.lists = loadListsIndex().length;
  stats.books = loadBooksIndex().length;
  stats.artifacts = listAllArtifacts().filter((a) => !a.is_dir).length;

  return stats;
}

/** Read a `specs/` directory into a `{ id: markdown }` map (id = filename stem). */
function readSpecsDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      out[name.slice(0, -3)] = fs.readFileSync(path.join(dir, name), "utf-8");
    } catch {}
  }
  return out;
}

const isNum = (s: string) => /^\d+$/.test(s);
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Read the entire /data store into the same bundle shape importBundle consumes,
 * so the host can reconstruct ~/.todo from the VM (the inverse of import). */
export function exportBundle(): MigrationBundle {
  // Days + specs
  const days: NonNullable<MigrationBundle["days"]> = [];
  for (const y of safeReaddir(STORAGE_ROOT).filter((n) => isNum(n) && n.length === 4)) {
    const yDir = path.join(STORAGE_ROOT, y);
    for (const m of safeReaddir(yDir).filter(isNum)) {
      const mDir = path.join(yDir, m);
      for (const d of safeReaddir(mDir).filter(isNum)) {
        const dDir = path.join(mDir, d);
        const file = path.join(dDir, "day.json");
        if (!fs.existsSync(file)) continue;
        const entry = readJson<{ date?: string; todos?: TodoLike[] }>(file, {});
        days.push({
          date: entry.date || `${y}-${m}-${d}`,
          todos: entry.todos ?? [],
          specs: readSpecsDir(path.join(dDir, "specs")),
        });
      }
    }
  }

  // Backlog + specs
  const backlogItems = fs.existsSync(BACKLOG_PATH)
    ? readJson<{ items: TodoLike[] }>(BACKLOG_PATH, { items: [] }).items ?? []
    : [];
  const backlog = { items: backlogItems, specs: readSpecsDir(BACKLOG_SPECS_DIR) };

  // Lists (full objects)
  const lists: List[] = loadListsIndex()
    .map((s) => {
      try {
        return getList(s.id);
      } catch {
        return null;
      }
    })
    .filter((l): l is List => l !== null);

  // Books (metadata + page markdown)
  const books: NonNullable<MigrationBundle["books"]> = [];
  for (const s of loadBooksIndex()) {
    const book = loadBook(s.id);
    if (!book) continue;
    const pages: Record<string, string> = {};
    for (const p of book.pages ?? []) {
      pages[p.id] = loadPage(book.id, p.id);
    }
    books.push({ book, pages });
  }

  // Artifacts (files only)
  const artifacts = listAllArtifacts()
    .filter((a) => !a.is_dir)
    .map((a) => ({ path: a.relative_path, content: readArtifactFile(a.relative_path) }));

  return { days, backlog, lists, books, artifacts };
}
