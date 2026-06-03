import { useEffect, useRef, useState } from "preact/hooks";
import {
  listBooks,
  loadBook,
  createBook,
  deleteBook,
  addPage,
  loadPage,
  savePage,
  updatePageMeta,
  reorderPages,
  deletePage,
} from "../../api/commands";
import { allBooks, pendingBookSelection, navigateToTodo } from "../../state/store";
import { getPref, setPref } from "../../state/uiPrefs";
import { useResizable } from "../../hooks/useResizable";
import { BlockNoteEditor, type BlockNoteHandle } from "./BlockNoteEditor";
import type { Book, BookPage } from "../../types";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

export function BooksPanel() {
  const [summaries, setSummaries] = useState(allBooks.value);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [current, setCurrent] = useState<Book | null>(null);
  const [creating, setCreating] = useState(false);
  const [newBookName, setNewBookName] = useState("");
  const [addingPage, setAddingPage] = useState(false);
  const [newPageTitle, setNewPageTitle] = useState("");

  // selected page + editor state
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [pageContent, setPageContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const editorRef = useRef<BlockNoteHandle>(null);

  // layout: panel widths + collapse (persisted per-device)
  const [railWidth, setRailWidth] = useState(() => getPref("books.railWidth", 180));
  const [tocWidth, setTocWidth] = useState(() => getPref("books.tocWidth", 220));
  const [railCollapsed, setRailCollapsed] = useState(() => getPref("books.railCollapsed", false));
  const [tocCollapsed, setTocCollapsed] = useState(() => getPref("books.tocCollapsed", false));

  const onRailResize = useResizable((dx) =>
    setRailWidth((w) => {
      const n = clamp(w + dx, 140, 400);
      setPref("books.railWidth", n);
      return n;
    }),
  );
  const onTocResize = useResizable((dx) =>
    setTocWidth((w) => {
      const n = clamp(w + dx, 160, 460);
      setPref("books.tocWidth", n);
      return n;
    }),
  );

  function toggleRail() {
    setRailCollapsed((v) => {
      setPref("books.railCollapsed", !v);
      return !v;
    });
  }
  function toggleToc() {
    setTocCollapsed((v) => {
      setPref("books.tocCollapsed", !v);
      return !v;
    });
  }

  async function reloadSummaries() {
    try {
      const s = await listBooks();
      setSummaries(s);
      allBooks.value = s;
    } catch {
      setSummaries([]);
    }
  }

  useEffect(() => {
    reloadSummaries();
  }, []);

  // Honour a cross-tab navigation request (linked-todo / mention chip click).
  useEffect(() => {
    const sel = pendingBookSelection.value;
    if (!sel) return;
    pendingBookSelection.value = null;
    (async () => {
      setCreating(false);
      setSelectedBookId(sel.bookId);
      try {
        const b = await loadBook(sel.bookId);
        setCurrent(b);
        const pid = sel.pageId && b.pages.some((p) => p.id === sel.pageId)
          ? sel.pageId
          : b.pages[0]?.id;
        if (pid) {
          selectPage(b, pid);
        } else {
          setSelectedPageId(null);
          setPageContent("");
        }
      } catch {
        setCurrent(null);
      }
    })();
  }, [pendingBookSelection.value]);

  async function selectBook(id: string) {
    setCreating(false);
    setSelectedBookId(id);
    setSelectedPageId(null);
    setPageContent("");
    try {
      const b = await loadBook(id);
      setCurrent(b);
      // auto-open first page if present
      if (b.pages.length > 0) selectPage(b, b.pages[0].id);
    } catch {
      setCurrent(null);
    }
  }

  async function selectPage(book: Book, pageId: string) {
    setSelectedPageId(pageId);
    setRenaming(false);
    setDirty(false);
    try {
      const content = await loadPage(book.id, pageId);
      setPageContent(content);
    } catch {
      setPageContent("");
    }
  }

  function startCreate() {
    setCreating(true);
    setSelectedBookId(null);
    setCurrent(null);
    setSelectedPageId(null);
    setNewBookName("");
  }

  async function submitCreate() {
    const name = newBookName.trim();
    if (!name) return;
    const book = await createBook(name);
    setCreating(false);
    await reloadSummaries();
    setSelectedBookId(book.id);
    setCurrent(book);
    setSelectedPageId(null);
  }

  async function handleDeleteBook() {
    if (!current) return;
    if (!confirm(`Delete book "${current.name}"? This cannot be undone.`)) return;
    await deleteBook(current.id);
    setCurrent(null);
    setSelectedBookId(null);
    setSelectedPageId(null);
    await reloadSummaries();
  }

  async function submitAddPage() {
    if (!current) return;
    const title = newPageTitle.trim() || "Untitled";
    const book = await addPage(current.id, title);
    setCurrent(book);
    setAddingPage(false);
    setNewPageTitle("");
    const added = book.pages[book.pages.length - 1];
    if (added) selectPage(book, added.id);
  }

  async function handleSavePage() {
    if (!current || !selectedPageId || !editorRef.current) return;
    const content = editorRef.current.getContent();
    const book = await savePage(current.id, selectedPageId, content);
    setCurrent(book);
    setPageContent(content);
    setDirty(false);
  }

  async function submitRename(page: BookPage) {
    if (!current) return;
    const title = renameTitle.trim() || page.title;
    const book = await updatePageMeta(current.id, page.id, title);
    setCurrent(book);
    setRenaming(false);
  }

  async function handleDeletePage(pageId: string) {
    if (!current) return;
    if (!confirm("Delete this page? This cannot be undone.")) return;
    const book = await deletePage(current.id, pageId);
    setCurrent(book);
    if (selectedPageId === pageId) {
      setSelectedPageId(null);
      setPageContent("");
    }
  }

  async function movePage(pageId: string, dir: -1 | 1) {
    if (!current) return;
    const ids = current.pages.map((p) => p.id);
    const idx = ids.indexOf(pageId);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    const book = await reorderPages(current.id, ids);
    setCurrent(book);
  }

  const selectedPage = current?.pages.find((p) => p.id === selectedPageId) ?? null;

  return (
    <div class="books-layout">
      {/* Left rail — book picker (collapsible / resizable) */}
      {railCollapsed ? (
        <button class="rail-expand-btn" onClick={toggleRail} title="Show books">›</button>
      ) : (
        <>
          <div class="books-rail" style={{ width: `${railWidth}px` }}>
            <div class="books-rail-header">
              <span>Books</span>
              <div class="books-rail-header-actions">
                <button class="btn btn-sm btn-primary" onClick={startCreate}>+ New</button>
                <button class="btn btn-sm btn-ghost" onClick={toggleRail} title="Collapse">‹</button>
              </div>
            </div>
            <div class="books-rail-items">
              {summaries.length === 0 ? (
                <div class="accordion-empty">No books yet</div>
              ) : (
                summaries.map((s) => (
                  <button
                    key={s.id}
                    class={`books-rail-item ${selectedBookId === s.id ? "active" : ""}`}
                    onClick={() => selectBook(s.id)}
                  >
                    {s.name}
                  </button>
                ))
              )}
            </div>
          </div>
          <div class="books-resize-handle" onMouseDown={onRailResize} />
        </>
      )}

      {creating ? (
        <div class="books-main">
          <div class="books-form">
            <h3>New book</h3>
            <input
              class="settings-input"
              type="text"
              placeholder="Book name (e.g. Standup notes)"
              value={newBookName}
              onInput={(e) => setNewBookName(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitCreate(); }}
            />
            <div class="books-form-actions">
              <button class="btn btn-secondary" onClick={() => setCreating(false)}>Cancel</button>
              <button class="btn btn-primary" onClick={submitCreate}>Create</button>
            </div>
          </div>
        </div>
      ) : current ? (
        <>
          {/* TOC sidebar (collapsible / resizable) */}
          {tocCollapsed ? (
            <button class="rail-expand-btn" onClick={toggleToc} title="Show pages">›</button>
          ) : (
            <>
              <div class="books-toc" style={{ width: `${tocWidth}px` }}>
                <div class="books-toc-header">
                  <span class="books-toc-title">{current.name}</span>
                  <div class="books-rail-header-actions">
                    <button class="btn btn-sm btn-ghost" onClick={toggleToc} title="Collapse">‹</button>
                    <button class="btn btn-sm btn-danger" onClick={handleDeleteBook} title="Delete book">✕</button>
                  </div>
                </div>
                <div class="books-toc-pages">
                  {current.pages.length === 0 ? (
                    <div class="accordion-empty">No pages</div>
                  ) : (
                    current.pages.map((p, i) => (
                      <div key={p.id} class={`books-toc-page ${selectedPageId === p.id ? "active" : ""}`}>
                        <button
                          class="books-toc-page-title"
                          onClick={() => selectPage(current, p.id)}
                        >
                          {p.title}
                        </button>
                        <div class="books-toc-page-actions">
                          <button class="btn btn-sm btn-ghost" disabled={i === 0} onClick={() => movePage(p.id, -1)} title="Move up">↑</button>
                          <button class="btn btn-sm btn-ghost" disabled={i === current.pages.length - 1} onClick={() => movePage(p.id, 1)} title="Move down">↓</button>
                          <button class="btn btn-sm btn-ghost" onClick={() => handleDeletePage(p.id)} title="Delete page">✕</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {addingPage ? (
                  <div class="books-add-page">
                    <input
                      class="settings-input"
                      type="text"
                      placeholder="Page title"
                      value={newPageTitle}
                      onInput={(e) => setNewPageTitle(e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") submitAddPage(); }}
                      autofocus
                    />
                    <div class="books-add-page-actions">
                      <button class="btn btn-sm btn-secondary" onClick={() => { setAddingPage(false); setNewPageTitle(""); }}>Cancel</button>
                      <button class="btn btn-sm btn-primary" onClick={submitAddPage}>Add</button>
                    </div>
                  </div>
                ) : (
                  <button class="btn btn-sm btn-secondary books-add-page-btn" onClick={() => setAddingPage(true)}>+ Page</button>
                )}
              </div>
              <div class="books-resize-handle" onMouseDown={onTocResize} />
            </>
          )}

          {/* Page editor */}
          <div class="books-page-main">
            {selectedPage ? (
              <>
                <div class="books-page-header">
                  {renaming ? (
                    <input
                      class="settings-input"
                      type="text"
                      value={renameTitle}
                      onInput={(e) => setRenameTitle(e.currentTarget.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") submitRename(selectedPage); }}
                      onBlur={() => submitRename(selectedPage)}
                      autofocus
                    />
                  ) : (
                    <h3
                      class="books-page-title"
                      onClick={() => { setRenaming(true); setRenameTitle(selectedPage.title); }}
                      title="Click to rename"
                    >
                      {selectedPage.title}
                    </h3>
                  )}
                  <button
                    class="btn btn-sm btn-primary"
                    onClick={handleSavePage}
                    disabled={!dirty}
                    title={dirty ? "Save page" : "No changes"}
                  >
                    {dirty ? "Save" : "Saved"}
                  </button>
                </div>
                {selectedPage.linked_todos.length > 0 && (
                  <div class="panel-linked-todos">
                    <span class="panel-linked-label">Linked todos:</span>
                    {selectedPage.linked_todos.map((ref) => (
                      <button
                        key={`${ref.date}:${ref.todo_id}`}
                        class="mention todo-link-chip"
                        onClick={() => navigateToTodo(ref)}
                        title="Open todo"
                      >
                        {ref.label || ref.todo_id}
                      </button>
                    ))}
                  </div>
                )}
                <div class="books-page-content">
                  <BlockNoteEditor
                    key={selectedPageId}
                    ref={editorRef}
                    content={pageContent}
                    onChange={() => { if (!dirty) setDirty(true); }}
                  />
                </div>
              </>
            ) : (
              <div class="accordion-empty">Select a page, or add one to get started.</div>
            )}
          </div>
        </>
      ) : (
        <div class="books-main">
          <div class="accordion-empty">Select a book or create a new one.</div>
        </div>
      )}
    </div>
  );
}
