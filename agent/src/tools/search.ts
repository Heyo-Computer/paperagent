import * as fs from "node:fs";
import * as path from "node:path";

import { loadDayEntry, loadSpecContent, loadBacklog, loadBacklogSpec } from "./todo.js";
import { listLists, getList } from "./lists.js";
import { listBooks, getBook, loadPage } from "./books.js";

const DATA_ROOT = "/data";
const STORAGE_ROOT = path.join(DATA_ROOT, "storage");
const ARTIFACTS_DIR = path.join(DATA_ROOT, "artifacts");
const CALENDAR_FILE = path.join(DATA_ROOT, "calendar", "events.json");
const INDEX_DIR = path.join(DATA_ROOT, "index");

// NOTE: This is NOT tree-sitter. The user data is prose/JSON, not source code,
// so "codegraph style" here means markdown heading-aware sectioning (see
// sectionMarkdown) rather than an AST. We keep zero new dependencies.

export type DocKind =
  | "todo"
  | "backlog"
  | "spec"
  | "list"
  | "list_item"
  | "book"
  | "page"
  | "artifact"
  | "calendar";

export interface IndexDoc {
  kind: DocKind;
  /** Stable id of the underlying entity (todo id, list id, book id, artifact relpath…). */
  id: string;
  date?: string;
  list_id?: string;
  item_id?: string;
  book_id?: string;
  page_id?: string;
  title: string;
  /** Nearest markdown heading for a section fragment, if any. */
  heading?: string;
  body: string;
  updated_at: string;
  /** Agent-readable mention token; echo verbatim to render a clickable chip. */
  token: string;
  /** Populated by searchIndex on the returned results only. */
  snippet?: string;
  score?: number;
}

// ── persisted index shape ──
// Each "source" is a logical entity keyed by a string; we remember the max mtime
// across the files that back it, so a query-time reconcile only re-extracts the
// entities whose files changed. No write-path hooks needed.
interface SourceEntry {
  mtimeMs: number;
  docs: IndexDoc[];
}

const INDEX_VERSION = 2;

// Manifest is a tiny key→mtime map; the docs themselves live in per-source shard
// files so we never rewrite the whole corpus on a single change.
interface Manifest {
  version: number;
  sources: Record<string, number>;
}

/**
 * In-memory index cache backed by per-source shard files on disk:
 *   <indexDir>/manifest.json        — { version, sources: { key: mtimeMs } }
 *   <indexDir>/sources/<enc>.json   — { key, mtimeMs, docs } for one source
 *
 * The agent is a long-lived singleton process, so the cache is hydrated once from
 * disk and thereafter reconciled in memory; `commit` writes only the shards that
 * changed (and deletes shards for sources that disappeared). A reconcile pass that
 * finds nothing changed performs zero writes.
 */
export class ShardStore {
  private mem: Map<string, SourceEntry> | null = null;

  constructor(private readonly indexDir: string) {}

  private get sourcesDir(): string {
    return path.join(this.indexDir, "sources");
  }
  private get manifestFile(): string {
    return path.join(this.indexDir, "manifest.json");
  }
  // Source keys contain ':' and '/'; base64url makes a flat, filesystem-safe name.
  private shardFile(key: string): string {
    return path.join(this.sourcesDir, `${Buffer.from(key).toString("base64url")}.json`);
  }

  /** Hydrated, mutable view of all cached sources (loaded from disk on first use). */
  snapshot(): Map<string, SourceEntry> {
    if (!this.mem) this.mem = this.hydrate();
    return this.mem;
  }

  private hydrate(): Map<string, SourceEntry> {
    const out = new Map<string, SourceEntry>();
    let manifest: Manifest | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.manifestFile, "utf-8"));
      if (raw && raw.version === INDEX_VERSION && raw.sources) manifest = raw;
    } catch {}
    if (!manifest) return out;
    for (const key of Object.keys(manifest.sources)) {
      try {
        const shard = JSON.parse(fs.readFileSync(this.shardFile(key), "utf-8"));
        if (shard && Array.isArray(shard.docs)) {
          out.set(key, { mtimeMs: shard.mtimeMs ?? manifest.sources[key], docs: shard.docs });
        }
      } catch {}
    }
    return out;
  }

  /** Apply a reconcile pass: upsert `next`, drop `removed`, and persist only the
   * dirty shards + removed shards (+ manifest). No-op write when nothing changed. */
  commit(
    next: Record<string, SourceEntry>,
    dirty: Set<string>,
    removed: string[],
  ): void {
    const mem = this.snapshot();
    for (const [k, v] of Object.entries(next)) mem.set(k, v);
    for (const k of removed) mem.delete(k);

    if (dirty.size === 0 && removed.length === 0) return;

    try {
      fs.mkdirSync(this.sourcesDir, { recursive: true });
      for (const k of dirty) {
        const e = next[k];
        if (!e) continue;
        fs.writeFileSync(
          this.shardFile(k),
          JSON.stringify({ key: k, mtimeMs: e.mtimeMs, docs: e.docs }),
          "utf-8",
        );
      }
      for (const k of removed) {
        try {
          fs.unlinkSync(this.shardFile(k));
        } catch {}
      }
      const manifest: Manifest = { version: INDEX_VERSION, sources: {} };
      for (const [k, v] of mem) manifest.sources[k] = v.mtimeMs;
      fs.writeFileSync(this.manifestFile, JSON.stringify(manifest), "utf-8");
    } catch {}
  }

  /** Drop the in-memory cache so the next access re-hydrates from disk (tests). */
  reset(): void {
    this.mem = null;
  }
}

// Module-level store for the live agent process, pointed at the real index dir.
let _store: ShardStore | null = null;
function getStore(): ShardStore {
  if (!_store) _store = new ShardStore(INDEX_DIR);
  return _store;
}

function mtimeOf(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function maxMtime(files: string[]): number {
  return files.reduce((m, f) => Math.max(m, mtimeOf(f)), 0);
}

// ── markdown sectioning ("codegraph style") ──
// Split a markdown body on ATX headings into heading-scoped fragments so results
// can surface the section they matched in. Plain regex — no markdown dependency.
export function sectionMarkdown(md: string): { heading?: string; body: string }[] {
  if (!md.trim()) return [];
  const lines = md.split(/\r?\n/);
  const sections: { heading?: string; body: string }[] = [];
  let heading: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body || heading) sections.push({ heading, body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return sections.length ? sections : [{ body: md.trim() }];
}

// Build per-entity docs for a markdown-bearing entity: one doc per heading-section
// of the body. Each section carries the entity title, so no title-only base doc is
// needed (it would just be an empty-body duplicate). Falls back to a title doc when
// the body has no sections at all.
function docsForMarkdown(
  base: Omit<IndexDoc, "body" | "heading">,
  md: string,
): IndexDoc[] {
  const sections = sectionMarkdown(md);
  if (!sections.length) return [{ ...base, body: base.title }];
  return sections.map((sec) => ({ ...base, heading: sec.heading, body: sec.body }));
}

// ── extractors ──

/** Walk /data/storage/YYYY/MM/DD looking for day.json files; skip the
 * lists/ books/ backlog/ subtrees which are handled by their own extractors. */
function findDayDirs(): string[] {
  const out: string[] = [];
  const skip = new Set(["lists", "books", "backlog"]);
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (depth === 0 && skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, "day.json"))) out.push(full);
      if (depth < 3) walk(full, depth + 1);
    }
  };
  walk(STORAGE_ROOT, 0);
  return out;
}

/** date string (YYYY-MM-DD) from a .../YYYY/MM/DD dir. */
function dateFromDayDir(dir: string): string {
  const parts = dir.split(path.sep);
  const [y, m, d] = parts.slice(-3);
  return `${y}-${m}-${d}`;
}

function todoToken(title: string, id: string, date: string): string {
  return `@[${title}](id:${id}|date:${date})`;
}

function extractDay(dayDir: string): IndexDoc[] {
  const date = dateFromDayDir(dayDir);
  const entry = loadDayEntry(date);
  const docs: IndexDoc[] = [];
  for (const t of entry.todos) {
    const base = {
      kind: "todo" as DocKind,
      id: t.id,
      date,
      title: t.title,
      updated_at: t.updated_at || "",
      token: todoToken(t.title, t.id, date),
    };
    const spec = t.has_spec ? loadSpecContent(date, t.id) : "";
    if (spec.trim()) {
      docs.push(...docsForMarkdown({ ...base, kind: "spec" }, spec));
    }
    docs.push({ ...base, body: t.title });
  }
  return docs;
}

function extractBacklog(): IndexDoc[] {
  const backlog = loadBacklog();
  const docs: IndexDoc[] = [];
  for (const t of backlog.items) {
    // Backlog todos have no date; token date is intentionally empty.
    const base = {
      kind: "backlog" as DocKind,
      id: t.id,
      date: "",
      title: t.title,
      updated_at: t.updated_at || "",
      token: todoToken(t.title, t.id, ""),
    };
    const spec = t.has_spec ? loadBacklogSpec(t.id) : "";
    if (spec.trim()) {
      docs.push(...docsForMarkdown({ ...base, kind: "spec" }, spec));
    }
    docs.push({ ...base, body: t.title });
  }
  return docs;
}

function extractList(listId: string): IndexDoc[] {
  const list = getList(listId);
  const docs: IndexDoc[] = [];
  docs.push({
    kind: "list",
    id: list.id,
    list_id: list.id,
    title: list.name,
    body: list.name,
    updated_at: list.updated_at || "",
    token: `@[${list.name}](list:${list.id})`,
  });
  for (const item of list.items) {
    // Body = the item's field values, flattened to text; label = first value.
    const vals = Object.values(item.values ?? {});
    const first = vals.find((v) => v != null && `${v}`.trim() !== "");
    const label = first != null ? `${first}` : "item";
    const body = vals.map((v) => `${v ?? ""}`).join(" ");
    docs.push({
      kind: "list_item",
      id: item.id,
      list_id: list.id,
      item_id: item.id,
      title: label,
      body: body || label,
      updated_at: item.updated_at || "",
      token: `@[${label}](list:${list.id}/${item.id})`,
    });
  }
  return docs;
}

function extractBook(bookId: string): IndexDoc[] {
  const book = getBook(bookId);
  const docs: IndexDoc[] = [];
  docs.push({
    kind: "book",
    id: book.id,
    book_id: book.id,
    title: book.name,
    body: book.name,
    updated_at: book.updated_at || "",
    token: `@[${book.name}](book:${book.id})`,
  });
  for (const page of book.pages) {
    const base = {
      kind: "page" as DocKind,
      id: page.id,
      book_id: book.id,
      page_id: page.id,
      title: page.title,
      updated_at: page.updated_at || "",
      token: `@[${page.title}](book:${book.id}/${page.id})`,
    };
    const md = loadPage(book.id, page.id);
    if (md.trim()) {
      docs.push(...docsForMarkdown(base, md));
    } else {
      docs.push({ ...base, body: page.title });
    }
  }
  return docs;
}

// Text-ish extensions we read the body of; everything else is title-only.
const TEXT_EXT = new Set([
  ".md", ".markdown", ".txt", ".text", ".json", ".yaml", ".yml", ".toml",
  ".csv", ".tsv", ".html", ".htm", ".xml", ".css",
  ".js", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".rb", ".sh", ".sql",
  ".c", ".h", ".cpp", ".java", ".log", ".env", ".ini", ".conf",
]);

/** Recursively collect artifact files (skip dotfiles/dirs), returning {abs, rel}. */
function findArtifacts(): { abs: string; rel: string }[] {
  const out: { abs: string; rel: string }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else if (e.isFile()) {
        const rel = path.relative(ARTIFACTS_DIR, abs).split(path.sep).join("/");
        out.push({ abs, rel });
      }
    }
  };
  walk(ARTIFACTS_DIR);
  return out;
}

function extractArtifact(abs: string, rel: string): IndexDoc[] {
  const name = path.basename(rel);
  let body = "";
  if (TEXT_EXT.has(path.extname(rel).toLowerCase())) {
    try {
      body = fs.readFileSync(abs, "utf-8");
    } catch {}
  }
  const base = {
    kind: "artifact" as DocKind,
    id: rel,
    title: name,
    updated_at: (() => {
      try {
        return new Date(fs.statSync(abs).mtimeMs).toISOString();
      } catch {
        return "";
      }
    })(),
    token: `@[${name}](artifact:${rel})`,
  };
  // Markdown artifacts get sectioned; everything else is one doc.
  if (/\.(md|markdown)$/i.test(rel) && body.trim()) {
    return docsForMarkdown(base, body);
  }
  return [{ ...base, body: body || name }];
}

// ── calendar ──
// The Tauri side caches synced Google Calendar events (past + upcoming) to a
// single JSON file. We index one doc per event so search_content can surface
// past meetings ("when did I last meet Hugo?") — the calendar_* tools only list
// a date window, so the index is the only way to find an event by keyword.
interface CalendarEventRec {
  id?: string;
  summary?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
  location?: string;
  meeting_url?: string;
  attendees?: string[];
}

function extractCalendar(): IndexDoc[] {
  let events: CalendarEventRec[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(CALENDAR_FILE, "utf-8"));
    if (Array.isArray(raw)) events = raw;
  } catch {
    return [];
  }
  const docs: IndexDoc[] = [];
  for (const e of events) {
    const summary = (e.summary ?? "").trim();
    if (!summary) continue;
    const date = (e.start_time ?? "").split("T")[0];
    // Body folds in everything searchable: time, place, attendees, agenda.
    const parts = [
      e.start_time ? `${e.start_time} - ${e.end_time ?? ""}` : "",
      e.location ?? "",
      (e.attendees ?? []).join(", "),
      e.meeting_url ?? "",
      e.description ?? "",
    ].filter((p) => p && p.trim());
    docs.push({
      kind: "calendar",
      id: e.id || `${date}:${summary}`,
      date: date.length === 10 ? date : undefined,
      title: summary,
      body: [summary, ...parts].join(" — "),
      updated_at: e.start_time || "",
      // No calendar route exists in the UI, so this token renders as plain text
      // rather than a clickable chip — it still gives the agent a label to echo.
      token: date ? `📅 ${summary} (${date})` : `📅 ${summary}`,
    });
  }
  return docs;
}

// ── index build (stat-based incremental, sharded persistence) ──

/** Reconcile the in-memory/sharded index, re-extracting only entities whose files
 * changed, and persist only the changed shards. Pass force=true to rebuild
 * everything. Returns the flat doc list. */
export function buildIndex(force = false): IndexDoc[] {
  const store = getStore();
  const prev = store.snapshot();

  const next: Record<string, SourceEntry> = {};
  const dirty = new Set<string>();
  const seen = new Set<string>();

  const reuseOrExtract = (
    key: string,
    files: string[],
    extract: () => IndexDoc[],
  ) => {
    seen.add(key);
    const mtimeMs = maxMtime(files);
    const cached = prev.get(key);
    if (!force && cached && cached.mtimeMs === mtimeMs && mtimeMs > 0) {
      next[key] = cached;
      return;
    }
    let docs: IndexDoc[] = [];
    try {
      docs = extract();
    } catch {
      docs = [];
    }
    next[key] = { mtimeMs, docs };
    dirty.add(key);
  };

  // todos + specs, one source per day
  for (const dayDir of findDayDirs()) {
    const specsDir = path.join(dayDir, "specs");
    let specFiles: string[] = [];
    try {
      specFiles = fs
        .readdirSync(specsDir)
        .map((f) => path.join(specsDir, f));
    } catch {}
    reuseOrExtract(
      `day:${dateFromDayDir(dayDir)}`,
      [path.join(dayDir, "day.json"), ...specFiles],
      () => extractDay(dayDir),
    );
  }

  // backlog
  {
    const backlogJson = path.join(STORAGE_ROOT, "backlog.json");
    const specsDir = path.join(STORAGE_ROOT, "backlog", "specs");
    let specFiles: string[] = [];
    try {
      specFiles = fs.readdirSync(specsDir).map((f) => path.join(specsDir, f));
    } catch {}
    reuseOrExtract("backlog", [backlogJson, ...specFiles], extractBacklog);
  }

  // lists
  for (const s of safe(() => listLists(), [])) {
    reuseOrExtract(
      `list:${s.id}`,
      [path.join(STORAGE_ROOT, "lists", `${s.id}.json`)],
      () => extractList(s.id),
    );
  }

  // books
  for (const s of safe(() => listBooks(), [])) {
    const dir = path.join(STORAGE_ROOT, "books", s.id);
    const pagesDir = path.join(dir, "pages");
    let pageFiles: string[] = [];
    try {
      pageFiles = fs.readdirSync(pagesDir).map((f) => path.join(pagesDir, f));
    } catch {}
    reuseOrExtract(
      `book:${s.id}`,
      [path.join(dir, "book.json"), ...pageFiles],
      () => extractBook(s.id),
    );
  }

  // artifacts, one source per file
  for (const { abs, rel } of findArtifacts()) {
    reuseOrExtract(`artifact:${rel}`, [abs], () => extractArtifact(abs, rel));
  }

  // calendar — one source backed by the single cached events file
  reuseOrExtract("calendar", [CALENDAR_FILE], extractCalendar);

  // Sources present in the cache but not seen this pass have been deleted.
  const removed = [...prev.keys()].filter((k) => !seen.has(k));
  store.commit(next, dirty, removed);

  return Object.values(next).flatMap((s) => s.docs);
}

function safe<T>(fn: () => T[], fallback: T[]): T[] {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ── search ──

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

export function makeSnippet(body: string, terms: string[], max = 200): string {
  if (!body) return "";
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - 40);
  const slice = body.slice(start, start + max).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + slice + (start + max < body.length ? "…" : "");
}

export interface SearchOpts {
  kinds?: DocKind[];
  limit?: number;
}

/** Search every indexed doc; returns ranked results with a snippet. Lazily
 * rebuilds the (stat-based) index first, so it always reflects current data. */
export function searchIndex(query: string, opts: SearchOpts = {}): IndexDoc[] {
  return rankDocs(buildIndex(), query, opts);
}

/** Pure scoring/snippet/kind-filter over a doc set — no filesystem access. Split
 * out of searchIndex so it can be unit-tested against synthetic docs. */
export function rankDocs(
  inputDocs: IndexDoc[],
  query: string,
  opts: SearchOpts = {},
): IndexDoc[] {
  const q = (query ?? "").trim();
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  const kinds = opts.kinds && opts.kinds.length ? new Set(opts.kinds) : null;

  let docs = inputDocs;
  if (kinds) docs = docs.filter((d) => kinds.has(d.kind));
  if (!q) return [];

  const terms = tokenize(q);
  const qLower = q.toLowerCase();

  const scored: IndexDoc[] = [];
  for (const doc of docs) {
    const haystack = `${doc.title} ${doc.heading ?? ""} ${doc.body}`.toLowerCase();
    const titleLower = `${doc.title} ${doc.heading ?? ""}`.toLowerCase();
    let score = 0;
    if (terms.length) {
      for (const term of terms) {
        let idx = haystack.indexOf(term);
        while (idx >= 0) {
          score += 1;
          idx = haystack.indexOf(term, idx + term.length);
        }
        if (titleLower.includes(term)) score += 5; // title-match boost
      }
    }
    // substring fallback for short / multi-word queries that didn't tokenize-hit
    if (score === 0 && qLower && haystack.includes(qLower)) score = 1;
    if (score > 0) scored.push({ ...doc, score });
  }

  scored.sort(
    (a, b) =>
      (b.score ?? 0) - (a.score ?? 0) ||
      (b.updated_at || "").localeCompare(a.updated_at || ""),
  );

  return scored.slice(0, limit).map((d) => ({
    ...d,
    snippet: makeSnippet(d.body, terms.length ? terms : [qLower]),
  }));
}
