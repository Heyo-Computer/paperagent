import { useEffect, useState } from "preact/hooks";
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
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import type { Book, BookPage } from "../../types";

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
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");

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
    setEditing(false);
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
    setEditing(false);
    setRenaming(false);
    try {
      const content = await loadPage(book.id, pageId);
      setPageContent(content);
      setDraft(content);
    } catch {
      setPageContent("");
      setDraft("");
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
    if (!current || !selectedPageId) return;
    const book = await savePage(current.id, selectedPageId, draft);
    setCurrent(book);
    setPageContent(draft);
    setEditing(false);
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
      setEditing(false);
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
      {/* Left rail — book picker */}
      <div class="books-rail">
        <div class="books-rail-header">
          <span>Books</span>
          <button class="btn btn-sm btn-primary" onClick={startCreate}>+ New</button>
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
          {/* TOC sidebar */}
          <div class="books-toc">
            <div class="books-toc-header">
              <span class="books-toc-title">{current.name}</span>
              <button class="btn btn-sm btn-danger" onClick={handleDeleteBook} title="Delete book">✕</button>
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
                  {!editing && (
                    <button class="btn btn-sm btn-secondary" onClick={() => { setDraft(pageContent); setEditing(true); }}>Edit</button>
                  )}
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
                {editing ? (
                  <>
                    <textarea
                      class="books-page-editor"
                      value={draft}
                      onInput={(e) => setDraft(e.currentTarget.value)}
                      placeholder="Write markdown..."
                    />
                    <div class="books-page-actions">
                      <button class="btn btn-sm btn-secondary" onClick={() => { setDraft(pageContent); setEditing(false); }}>Cancel</button>
                      <button class="btn btn-sm btn-primary" onClick={handleSavePage}>Save</button>
                    </div>
                  </>
                ) : (
                  <div class="books-page-content" onClick={() => { setDraft(pageContent); setEditing(true); }}>
                    {pageContent ? (
                      <MarkdownRenderer content={pageContent} />
                    ) : (
                      <div class="accordion-empty">Empty page — click to edit.</div>
                    )}
                  </div>
                )}
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
