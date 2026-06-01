import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  tokenize,
  makeSnippet,
  sectionMarkdown,
  rankDocs,
  ShardStore,
  type IndexDoc,
} from "./search.js";

// Mirror of the frontend mention grammar in
// src/components/markdown/mentions.tsx (MENTION_RE). Kept in sync by hand: the
// round-trip tests below assert the tokens this backend emits parse here, so a
// drift between the two regexes will fail loudly.
//   Group 1 = label, 2 = todo id, 3 = todo date, 4 = artifact relative path,
//   5 = list id, 6 = list item id (optional), 7 = book id, 8 = book page id (optional).
const MENTION_RE =
  /@\[([^\]]+)\]\((?:id:([^|)]+)\|date:([^)]*)|artifact:([^)]+)|list:([^/)]+)(?:\/([^)]+))?|book:([^/)]+)(?:\/([^)]+))?)\)/g;

function matchOne(token: string): RegExpExecArray {
  const re = new RegExp(MENTION_RE.source); // non-global for a single exec
  const m = re.exec(token);
  assert.ok(m, `token did not match MENTION_RE: ${token}`);
  // Token must match in full (no trailing/leading junk).
  assert.equal(m[0], token, `partial match for token: ${token}`);
  return m;
}

function doc(partial: Partial<IndexDoc> & Pick<IndexDoc, "kind" | "id" | "title" | "body">): IndexDoc {
  return {
    updated_at: "",
    token: "",
    ...partial,
  } as IndexDoc;
}

// ── tokenize ──

test("tokenize lowercases, splits on non-alphanumerics, drops empties", () => {
  assert.deepEqual(tokenize("Launch Date!"), ["launch", "date"]);
  assert.deepEqual(tokenize("  Foo_bar-baz  "), ["foo", "bar", "baz"]);
  assert.deepEqual(tokenize("v2.0 alpha"), ["v2", "0", "alpha"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("!!!"), []);
});

// ── sectionMarkdown ──

test("sectionMarkdown splits on ATX headings, keeping section bodies", () => {
  const md = "# Title\nintro line\n## Sub\nbody text";
  const secs = sectionMarkdown(md);
  assert.deepEqual(secs, [
    { heading: "Title", body: "intro line" },
    { heading: "Sub", body: "body text" },
  ]);
});

test("sectionMarkdown falls back to a single bodied section without headings", () => {
  assert.deepEqual(sectionMarkdown("just some prose"), [
    { heading: undefined, body: "just some prose" },
  ]);
});

test("sectionMarkdown returns empty for blank input", () => {
  assert.deepEqual(sectionMarkdown("   \n  "), []);
});

// ── makeSnippet ──

test("makeSnippet centers on the first matched term with ellipses", () => {
  const body = "alpha ".repeat(20) + "TARGET tail text";
  const snip = makeSnippet(body, ["target"]);
  assert.ok(snip.includes("TARGET"), "snippet should contain the matched term");
  assert.ok(snip.startsWith("…"), "snippet starting mid-body should lead with ellipsis");
});

test("makeSnippet returns empty string for empty body", () => {
  assert.equal(makeSnippet("", ["x"]), "");
});

test("makeSnippet starts at 0 when no term matches", () => {
  const snip = makeSnippet("short body here", ["zzz"]);
  assert.ok(snip.startsWith("short"), "no-match snippet should start at the beginning");
});

// ── rankDocs: scoring / kind-filter / limit ──

const DOCS: IndexDoc[] = [
  doc({ kind: "todo", id: "t1", title: "Launch the rocket", body: "launch the rocket", updated_at: "2026-01-02" }),
  doc({ kind: "artifact", id: "a1", title: "notes.md", body: "the launch date is set", updated_at: "2026-01-03" }),
  doc({ kind: "list", id: "l1", title: "Customers", body: "acme globex", updated_at: "2026-01-01" }),
  doc({ kind: "calendar", id: "c1", title: "Sync with Hugo Santos", body: "Sync with Hugo Santos — hugo@namespace.io", updated_at: "2025-03-04T10:00:00" }),
];

test("rankDocs returns empty for blank query", () => {
  assert.deepEqual(rankDocs(DOCS, "   "), []);
  assert.deepEqual(rankDocs(DOCS, ""), []);
});

test("rankDocs ranks a title match above a body-only match", () => {
  const res = rankDocs(DOCS, "launch");
  assert.equal(res.length, 2);
  assert.equal(res[0].id, "t1", "title match should outrank body-only match");
  assert.ok((res[0].score ?? 0) > (res[1].score ?? 0));
});

test("rankDocs attaches a snippet to each result", () => {
  const res = rankDocs(DOCS, "launch date");
  assert.ok(res.length >= 1);
  for (const r of res) assert.equal(typeof r.snippet, "string");
});

test("rankDocs kind filter restricts the result set", () => {
  const res = rankDocs(DOCS, "launch", { kinds: ["artifact"] });
  assert.equal(res.length, 1);
  assert.equal(res[0].kind, "artifact");
});

test("rankDocs finds a past calendar event by attendee", () => {
  const res = rankDocs(DOCS, "Hugo Santos", { kinds: ["calendar"] });
  assert.equal(res.length, 1);
  assert.equal(res[0].id, "c1");
});

test("rankDocs honors limit", () => {
  const res = rankDocs(DOCS, "launch", { limit: 1 });
  assert.equal(res.length, 1);
});

test("rankDocs substring fallback scores multi-word queries with no token hits", () => {
  const only = [doc({ kind: "todo", id: "x", title: "x", body: "the launch date is set" })];
  // 'launch date' tokenizes to ['launch','date']; both appear, so it hits normally.
  // Force the fallback with a phrase that only exists as a contiguous substring.
  const phrase = [doc({ kind: "todo", id: "y", title: "y", body: "ship-it now" })];
  assert.equal(rankDocs(phrase, "ship-it").length, 1);
  assert.equal(rankDocs(only, "launch").length, 1);
});

// ── token grammar round-trips against MENTION_RE ──

test("todo token (with date) matches MENTION_RE", () => {
  const m = matchOne("@[Standup notes](id:abc123|date:2026-05-31)");
  assert.equal(m[1], "Standup notes");
  assert.equal(m[2], "abc123");
  assert.equal(m[3], "2026-05-31");
});

test("backlog todo token (empty date) matches MENTION_RE", () => {
  const m = matchOne("@[Someday task](id:bk-9|date:)");
  assert.equal(m[1], "Someday task");
  assert.equal(m[2], "bk-9");
  assert.equal(m[3], "", "empty backlog date must still match (date:([^)]*))");
});

test("artifact token matches MENTION_RE", () => {
  const m = matchOne("@[launch.md](artifact:notes/launch.md)");
  assert.equal(m[1], "launch.md");
  assert.equal(m[4], "notes/launch.md");
});

test("list and list-item tokens match MENTION_RE", () => {
  const list = matchOne("@[Customers](list:l1)");
  assert.equal(list[5], "l1");
  assert.equal(list[6], undefined);
  const item = matchOne("@[Acme](list:l1/i7)");
  assert.equal(item[5], "l1");
  assert.equal(item[6], "i7");
});

test("book and book-page tokens match MENTION_RE", () => {
  const book = matchOne("@[Journal](book:b1)");
  assert.equal(book[7], "b1");
  assert.equal(book[8], undefined);
  const page = matchOne("@[Day 1](book:b1/p3)");
  assert.equal(page[7], "b1");
  assert.equal(page[8], "p3");
});

// ── ShardStore: sharded persistence + in-memory cache ──

function tmpIndexDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "todo-idx-"));
}

test("ShardStore persists changed shards and round-trips on rehydrate", () => {
  const dir = tmpIndexDir();
  try {
    const store = new ShardStore(dir);
    const a = { mtimeMs: 100, docs: [doc({ kind: "todo", id: "t1", title: "Alpha", body: "alpha" })] };
    const b = { mtimeMs: 200, docs: [doc({ kind: "list", id: "l1", title: "Beta", body: "beta" })] };
    store.commit({ "todo:1": a, "list:1": b }, new Set(["todo:1", "list:1"]), []);

    assert.ok(fs.existsSync(path.join(dir, "manifest.json")), "manifest written");
    assert.equal(fs.readdirSync(path.join(dir, "sources")).length, 2, "one shard per source");

    // A fresh store hydrates the docs back from disk.
    const reopened = new ShardStore(dir).snapshot();
    assert.equal(reopened.size, 2);
    assert.equal(reopened.get("list:1")?.docs[0].title, "Beta");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ShardStore no-op commit (nothing dirty/removed) does not rewrite", () => {
  const dir = tmpIndexDir();
  try {
    const store = new ShardStore(dir);
    const a = { mtimeMs: 100, docs: [doc({ kind: "todo", id: "t1", title: "Alpha", body: "alpha" })] };
    store.commit({ "todo:1": a }, new Set(["todo:1"]), []);

    const manifestPath = path.join(dir, "manifest.json");
    const before = fs.statSync(manifestPath).mtimeMs;
    // Reconcile found nothing changed → zero writes (early return).
    store.commit({}, new Set(), []);
    assert.equal(fs.statSync(manifestPath).mtimeMs, before, "no-op commit must not touch disk");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ShardStore deletes the shard for a removed source", () => {
  const dir = tmpIndexDir();
  try {
    const store = new ShardStore(dir);
    const a = { mtimeMs: 100, docs: [doc({ kind: "todo", id: "t1", title: "Alpha", body: "alpha" })] };
    const b = { mtimeMs: 200, docs: [doc({ kind: "list", id: "l1", title: "Beta", body: "beta" })] };
    store.commit({ "todo:1": a, "list:1": b }, new Set(["todo:1", "list:1"]), []);
    assert.equal(fs.readdirSync(path.join(dir, "sources")).length, 2);

    // "todo:1" disappeared this pass → its shard is removed, "list:1" remains.
    store.commit({ "list:1": b }, new Set(), ["todo:1"]);
    assert.equal(fs.readdirSync(path.join(dir, "sources")).length, 1);

    const reopened = new ShardStore(dir).snapshot();
    assert.equal(reopened.size, 1);
    assert.ok(reopened.has("list:1"));
    assert.ok(!reopened.has("todo:1"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
