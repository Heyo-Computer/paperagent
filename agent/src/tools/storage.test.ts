import { test, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The storage modules read their root from HEYO_DATA_DIR at import time, so we
// set it to a fresh temp dir BEFORE importing them (via dynamic import).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "heyo-storage-test-"));
process.env.HEYO_DATA_DIR = DATA_DIR;

type ListsMod = typeof import("./lists.js");
type ArtifactMod = typeof import("./artifact.js");
type MigrationMod = typeof import("./migration.js");

let lists: ListsMod;
let artifact: ArtifactMod;
let migration: MigrationMod;

before(async () => {
  lists = await import("./lists.js");
  artifact = await import("./artifact.js");
  migration = await import("./migration.js");
});

// ── lists: archived round-trips ──

test("updateListItem persists archived true/false", () => {
  const list = lists.createList("T", [{ key: "name", label: "Name", kind: "text" }]);
  const withItem = lists.addListItem(list.id, { name: "row" });
  const item = withItem.items[0];
  assert.equal(item.archived, false, "new items default to not archived");

  let updated = lists.updateListItem(list.id, { ...item, archived: true });
  assert.equal(updated.items[0].archived, true);

  // Reload from disk to confirm it persisted, not just in-memory.
  const reloaded = lists.getList(list.id);
  assert.equal(reloaded.items[0].archived, true);

  updated = lists.updateListItem(list.id, { ...item, archived: false });
  assert.equal(lists.getList(list.id).items[0].archived, false);
});

// ── artifacts: folder-aware CRUD ──

test("artifact save/list/read/rename/move/delete round-trip", () => {
  const saved = artifact.saveArtifactFile("notes/a.md", "hello");
  assert.equal(saved.relative_path, "notes/a.md");
  assert.equal(saved.is_dir, false);
  assert.equal(artifact.readArtifactFile("notes/a.md"), "hello");

  // root listing shows the folder; folder listing shows the file
  const root = artifact.listArtifactsIn("");
  assert.ok(root.some((a) => a.name === "notes" && a.is_dir));
  const inNotes = artifact.listArtifactsIn("notes");
  assert.ok(inNotes.some((a) => a.name === "a.md"));

  // rename within folder, index re-points
  const renamed = artifact.renameArtifactPath("notes/a.md", "b.md");
  assert.equal(renamed.relative_path, "notes/b.md");
  assert.equal(artifact.readArtifactFile("notes/b.md"), "hello");

  // move to root
  artifact.createArtifactFolder("archive");
  const moved = artifact.moveArtifactPath("notes/b.md", "archive");
  assert.equal(moved.relative_path, "archive/b.md");

  // list_all is flat and includes folders + files
  const all = artifact.listAllArtifacts();
  assert.ok(all.some((a) => a.relative_path === "archive/b.md"));

  // delete
  artifact.deleteArtifactPath("archive/b.md");
  assert.throws(() => artifact.readArtifactFile("archive/b.md"));
});

test("artifact path traversal is rejected", () => {
  assert.throws(() => artifact.saveArtifactFile("../escape.txt", "x"));
});

// ── migration: importBundle seeds days/backlog/lists/books/artifacts ──

test("importBundle writes a full snapshot and stats reflect it", () => {
  const before = migration.migrationStats();

  const result = migration.importBundle({
    days: [
      {
        date: "2026-01-15",
        todos: [{ id: "t1", title: "Ship", completed: false, has_spec: true, created_at: "", updated_at: "" }],
        specs: { t1: "# Ship\nplan" },
      },
    ],
    backlog: { items: [{ id: "b1", title: "Idea", completed: false, has_spec: false, created_at: "", updated_at: "" }] },
    lists: [
      {
        id: "list-1",
        name: "Imported",
        fields: [{ key: "name", label: "Name", kind: "text" }],
        items: [{ id: "i1", values: { name: "x" }, linked_todos: [], archived: false, created_at: "", updated_at: "" }],
        created_at: "",
        updated_at: "",
      },
    ],
    books: [
      {
        book: {
          id: "book-1",
          name: "Imported Book",
          pages: [{ id: "p1", title: "Page 1", order: 0, linked_todos: [], created_at: "", updated_at: "" }],
          created_at: "",
          updated_at: "",
        },
        pages: { p1: "# Page 1\nbody" },
      },
    ],
    artifacts: [{ path: "imported/file.txt", content: "data" }],
  });

  assert.deepEqual(result, { days: 1, todos: 1, backlog: 1, lists: 1, books: 1, artifacts: 1 });

  // Verify each side landed and is readable through the normal accessors.
  assert.equal(artifact.readArtifactFile("imported/file.txt"), "data");
  assert.ok(lists.listLists().some((l) => l.id === "list-1"));
  assert.equal(lists.getList("list-1").items[0].values.name, "x");

  const after = migration.migrationStats();
  assert.equal(after.days, before.days + 1);
  assert.equal(after.lists, before.lists + 1);
  assert.equal(after.books, before.books + 1);
  assert.ok(after.artifacts >= before.artifacts + 1);
});

test("exportBundle round-trips the imported snapshot", () => {
  // After the import test above, export should surface that data faithfully.
  const bundle = migration.exportBundle();

  const day = bundle.days?.find((d) => d.date === "2026-01-15");
  assert.ok(day, "exported day present");
  assert.equal(day!.todos.length, 1);
  assert.equal(day!.specs?.t1, "# Ship\nplan");

  assert.ok(bundle.backlog?.items.some((i) => (i as { id: string }).id === "b1"));

  const list = bundle.lists?.find((l) => l.id === "list-1");
  assert.ok(list, "exported list present");
  assert.equal(list!.items[0].values.name, "x");

  const book = bundle.books?.find((b) => b.book.id === "book-1");
  assert.ok(book, "exported book present");
  assert.equal(book!.pages?.p1, "# Page 1\nbody");

  assert.ok(bundle.artifacts?.some((a) => a.path === "imported/file.txt" && a.content === "data"));
});
