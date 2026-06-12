import { useCallback, useEffect, useRef, useState } from "preact/hooks";
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
  structureNote,
} from "../../api/commands";
import { allBooks, pendingBookSelection, navigateToTodo } from "../../state/store";
import { getPref, setPref } from "../../state/uiPrefs";
import { useResizable } from "../../hooks/useResizable";
import { useVoiceCapture } from "../../hooks/useVoiceCapture";
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
  // The editor is uncontrolled and seeds from `loaded.content` on mount. Content
  // and the page it belongs to are kept in ONE atomic object (never two separate
  // state vars) so the editor can only ever mount when `loaded.id` matches the
  // page it's seeding — otherwise it would seed with another page's content and
  // save it back to the wrong page. The editor mounts only when
  // `loaded.id === selectedPageId`.
  const [loaded, setLoaded] = useState<{ id: string; content: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const editorRef = useRef<BlockNoteHandle>(null);

  // Monotonic token: only the newest page-load is allowed to apply its result,
  // so an earlier `loadPage` that resolves late can't clobber a later selection.
  const loadSeq = useRef(0);
  // Live mirrors for the async flush (cleanup/navigation can't read fresh state).
  const dirtyRef = useRef(false);
  const currentRef = useRef<Book | null>(null);
  currentRef.current = current;
  const markDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirty(v);
  };

  // Stable across renders so the memoised editor never re-renders mid-edit.
  // `setDirty` is stable (useState) and `dirtyRef` is a ref, so [] deps are safe.
  const handleEditorChange = useCallback(() => {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      setDirty(true);
    }
  }, []);

  // Persist the currently-open editor to ITS OWN page before we navigate away or
  // unmount. Bound to `handle.pageId`, never `selectedPageId`, so it can't write
  // one page's content into another. No-op unless there are unsaved edits.
  async function flushCurrentPage() {
    const handle = editorRef.current;
    const book = currentRef.current;
    if (!handle || !book || !dirtyRef.current) return;
    dirtyRef.current = false;
    try {
      await savePage(book.id, handle.pageId, handle.getContent());
    } catch {
      /* best-effort autosave; the explicit Save button surfaces errors */
    }
  }

  // Dictate-a-page: record voice → transcribe → run through the agent to strip
  // noise and impose structure → create a new page seeded with the markdown.
  const [structuring, setStructuring] = useState(false);
  const [voiceErr, setVoiceErr] = useState("");
  const { state: voiceState, error: captureErr, toggle: toggleVoice } = useVoiceCapture(
    async (transcript) => {
      if (!current) return;
      if (!transcript) {
        setVoiceErr("Nothing was transcribed — try again.");
        return;
      }
      setStructuring(true);
      setVoiceErr("");
      try {
        const { title, markdown } = await structureNote(transcript);
        let book = await addPage(current.id, title || "Voice note");
        const added = book.pages[book.pages.length - 1];
        if (added) book = await savePage(current.id, added.id, markdown);
        setCurrent(book);
        await reloadSummaries();
        if (added) selectPage(book, added.id);
      } catch (e) {
        setVoiceErr(`${e}`);
      } finally {
        setStructuring(false);
      }
    },
  );

  // Transcribe-into-page: record voice → transcribe → append the raw transcript
  // to the page currently open in the editor (no structuring pass).
  const [pageVoiceErr, setPageVoiceErr] = useState("");
  const {
    state: pageVoiceState,
    error: pageCaptureErr,
    toggle: togglePageVoice,
  } = useVoiceCapture(async (transcript) => {
    if (!transcript) {
      setPageVoiceErr("Nothing was transcribed — try again.");
      return;
    }
    const ed = editorRef.current;
    if (!ed) return;
    setPageVoiceErr("");
    try {
      await ed.appendMarkdown(transcript);
      markDirty(true);
    } catch (e) {
      setPageVoiceErr(`${e}`);
    }
  });

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
    // Persist unsaved edits when the panel unmounts (e.g. switching tabs away
    // from Books), so navigating away never silently drops the current page.
    return () => {
      void flushCurrentPage();
    };
  }, []);

  // Honour a cross-tab navigation request (linked-todo / mention chip click).
  useEffect(() => {
    const sel = pendingBookSelection.value;
    if (!sel) return;
    pendingBookSelection.value = null;
    (async () => {
      await flushCurrentPage();
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
          setLoaded(null);
          markDirty(false);
        }
      } catch {
        setCurrent(null);
      }
    })();
  }, [pendingBookSelection.value]);

  async function selectBook(id: string) {
    await flushCurrentPage();
    setCreating(false);
    setSelectedBookId(id);
    setSelectedPageId(null);
    setLoaded(null);
    markDirty(false);
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
    // Persist the outgoing page's edits (to its OWN id) before switching away.
    await flushCurrentPage();
    const seq = ++loadSeq.current;
    setSelectedPageId(pageId);
    setRenaming(false);
    markDirty(false);
    // Tear the editor down until the matching content has loaded, so it never
    // remounts seeded with the previously-selected page's content.
    setLoaded(null);
    let content = "";
    try {
      content = await loadPage(book.id, pageId);
    } catch {
      content = "";
    }
    // A newer selection superseded this load while we awaited — drop the result
    // so a slow/early load can't clobber the page the user is now on.
    if (seq !== loadSeq.current) return;
    setLoaded({ id: pageId, content });
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
    const handle = editorRef.current;
    if (!current || !handle) return;
    // Save to the page THIS editor is bound to — never an ambient
    // `selectedPageId`, which may have drifted to another page.
    const pageId = handle.pageId;
    const content = handle.getContent();
    const book = await savePage(current.id, pageId, content);
    setCurrent(book);
    setLoaded((l) => (l && l.id === pageId ? { id: pageId, content } : l));
    markDirty(false);
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
    // Drop any unsaved edits for the page being deleted so the flush below
    // (or a stray autosave) can't resurrect it.
    if (editorRef.current?.pageId === pageId) markDirty(false);
    const book = await deletePage(current.id, pageId);
    setCurrent(book);
    if (selectedPageId === pageId) {
      setSelectedPageId(null);
      setLoaded(null);
      markDirty(false);
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
                  <div class="books-add-page-row">
                    <button
                      class="btn btn-sm btn-secondary"
                      onClick={() => setAddingPage(true)}
                      disabled={voiceState !== "idle" || structuring}
                    >
                      + Page
                    </button>
                    <button
                      class={`btn btn-sm ${voiceState === "recording" ? "btn-danger" : "btn-secondary"}`}
                      onClick={toggleVoice}
                      disabled={voiceState === "transcribing" || structuring}
                      title="Dictate a page — records your voice, transcribes it, and structures it into markdown"
                    >
                      {voiceState === "recording"
                        ? "● Stop"
                        : voiceState === "transcribing"
                          ? "Transcribing…"
                          : structuring
                            ? "Structuring…"
                            : "🎤 Dictate"}
                    </button>
                  </div>
                )}
                {(voiceErr || captureErr) && (
                  <div class="books-voice-error">{voiceErr || captureErr}</div>
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
                  <div class="books-page-header-actions">
                    <button
                      class={`btn btn-sm ${pageVoiceState === "recording" ? "btn-danger" : "btn-secondary"}`}
                      onClick={togglePageVoice}
                      disabled={pageVoiceState === "transcribing"}
                      title="Record voice and append the transcription to this page"
                    >
                      {pageVoiceState === "recording"
                        ? "● Stop"
                        : pageVoiceState === "transcribing"
                          ? "Transcribing…"
                          : "🎤 Transcribe"}
                    </button>
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={handleSavePage}
                      disabled={!dirty}
                      title={dirty ? "Save page" : "No changes"}
                    >
                      {dirty ? "Save" : "Saved"}
                    </button>
                  </div>
                </div>
                {(pageVoiceErr || pageCaptureErr) && (
                  <div class="books-voice-error">{pageVoiceErr || pageCaptureErr}</div>
                )}
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
                  {loaded && loaded.id === selectedPageId ? (
                    <BlockNoteEditor
                      key={loaded.id}
                      pageId={loaded.id}
                      ref={editorRef}
                      content={loaded.content}
                      onChange={handleEditorChange}
                    />
                  ) : (
                    <div class="accordion-empty">Loading…</div>
                  )}
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
