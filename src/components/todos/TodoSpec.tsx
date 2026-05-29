import { useState, useEffect } from "preact/hooks";
import { loadSpec, saveSpec, unlinkTodoFromListItem, unlinkTodoFromBookPage, createPageFromTodo, createListItemFromTodo } from "../../api/commands";
import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import { useReadAloud } from "../../hooks/useReadAloud";
import { navigateToLink, allBooks, allLists, activeTab, pendingBookSelection, pendingListSelection } from "../../state/store";
import type { TodoItem, LinkRef } from "../../types";

interface TodoSpecProps {
  todo: TodoItem;
  date: string;
  onUpdate: (todo: TodoItem) => void;
}

export function TodoSpec({ todo, date, onUpdate }: TodoSpecProps) {
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const { speaking, toggle: toggleSpeak, stop: stopSpeak } = useReadAloud();

  useEffect(() => {
    loadSpec(date, todo.id).then((spec) => {
      setContent(spec);
      setDraft(spec);
    }).catch(() => {});
  }, [date, todo.id]);

  async function handleSave() {
    await saveSpec(date, todo.id, draft);
    setContent(draft);
    setEditing(false);

    if (!todo.has_spec && draft.length > 0) {
      onUpdate({ ...todo, has_spec: true });
    } else if (todo.has_spec && draft.length === 0) {
      onUpdate({ ...todo, has_spec: false });
    }
  }

  function handleCancel() {
    setDraft(content);
    setEditing(false);
  }

  async function handleUnlink(link: LinkRef) {
    if (link.kind === "list") {
      await unlinkTodoFromListItem(date, todo.id, link.target_id, link.sub_id);
    } else {
      await unlinkTodoFromBookPage(date, todo.id, link.target_id, link.sub_id);
    }
    onUpdate({
      ...todo,
      links: (todo.links ?? []).filter(
        (l) => !(l.kind === link.kind && l.target_id === link.target_id && l.sub_id === link.sub_id),
      ),
    });
  }

  async function handleSendToBook(bookId: string) {
    setSendOpen(false);
    const { page_id } = await createPageFromTodo(date, todo.id, bookId);
    onUpdate({
      ...todo,
      links: [
        ...(todo.links ?? []),
        { kind: "book", target_id: bookId, sub_id: page_id, label: todo.title },
      ],
    });
    pendingBookSelection.value = { bookId, pageId: page_id };
    activeTab.value = "books";
  }

  async function handleSendToList(listId: string) {
    setSendOpen(false);
    const { item_id, list } = await createListItemFromTodo(date, todo.id, listId);
    onUpdate({
      ...todo,
      links: [
        ...(todo.links ?? []),
        { kind: "list", target_id: listId, sub_id: item_id, label: list.name },
      ],
    });
    pendingListSelection.value = { listId, itemId: item_id };
    activeTab.value = "lists";
  }

  // Stop speech when unmounting or switching to edit
  useEffect(() => () => stopSpeak(), []);

  return (
    <>
      {todo.links && todo.links.length > 0 && (
        <div class="todo-spec-links">
          {todo.links.map((link) => (
            <span
              key={`${link.kind}:${link.target_id}/${link.sub_id}`}
              class={`mention mention-${link.kind} todo-link-chip`}
            >
              <button class="todo-link-chip-label" onClick={() => navigateToLink(link)} title={`Open ${link.kind}`}>
                {link.label || link.sub_id}
              </button>
              <button class="todo-link-unlink" onClick={() => handleUnlink(link)} title="Unlink">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="todo-send">
        <button class="btn btn-sm btn-ghost" onClick={() => setSendOpen((v) => !v)} title="Create a book page or list item from this todo">
          Send to…
        </button>
        {sendOpen && (
          <div class="todo-send-menu">
            <div class="todo-send-section">Books</div>
            {allBooks.value.length === 0 && <div class="todo-send-empty">No books</div>}
            {allBooks.value.map((b) => (
              <button key={`book-${b.id}`} class="todo-send-item" onClick={() => handleSendToBook(b.id)}>
                + Page in {b.name}
              </button>
            ))}
            <div class="todo-send-section">Lists</div>
            {allLists.value.length === 0 && <div class="todo-send-empty">No lists</div>}
            {allLists.value.map((l) => (
              <button key={`list-${l.id}`} class="todo-send-item" onClick={() => handleSendToList(l.id)}>
                + Item in {l.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div class="todo-spec">
        {editing ? (
          <>
            <textarea
              class="todo-spec-editor"
              value={draft}
              onInput={(e) => setDraft(e.currentTarget.value)}
              placeholder="Write a markdown spec..."
              rows={8}
            />
            <div class="todo-spec-actions">
              <button class="btn btn-sm btn-secondary" onClick={handleCancel}>
                Cancel
              </button>
              <button class="btn btn-sm btn-primary" onClick={handleSave}>
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            {content ? (
              <div class="todo-spec-content-row">
                <div
                  class="todo-spec-content"
                  onClick={() => setEditing(true)}
                  style={{ cursor: "pointer", flex: 1 }}
                >
                  <MarkdownRenderer content={content} />
                </div>
                <button
                  class={`btn btn-sm btn-ghost spec-action-btn${speaking ? " speaking" : ""}`}
                  onClick={() => toggleSpeak(content)}
                  title={speaking ? "Stop reading" : "Read aloud"}
                >
                  {speaking ? "\u25A0" : "\u25B6"}
                </button>
                <button
                  class="btn btn-sm btn-ghost spec-action-btn"
                  onClick={() => setModalOpen(true)}
                  title="Expand spec"
                >
                  &#x2922;
                </button>
              </div>
            ) : (
              <button
                class="btn btn-sm btn-ghost"
                onClick={() => setEditing(true)}
              >
                + Add spec
              </button>
            )}
          </>
        )}
      </div>

      {modalOpen && (
        <SpecModal
          title={todo.title}
          content={content}
          onClose={() => setModalOpen(false)}
          onEdit={() => {
            setModalOpen(false);
            setEditing(true);
          }}
        />
      )}
    </>
  );
}

function SpecModal({
  title,
  content,
  onClose,
  onEdit,
}: {
  title: string;
  content: string;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { speaking, toggle: toggleSpeak, stop: stopSpeak } = useReadAloud();

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Stop speech on unmount
  useEffect(() => () => stopSpeak(), []);

  return (
    <div class="spec-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="spec-modal">
        <div class="spec-modal-header">
          <span class="spec-modal-title">{title}</span>
          <div class="spec-modal-header-actions">
            <button
              class={`btn btn-sm btn-ghost${speaking ? " speaking" : ""}`}
              onClick={() => toggleSpeak(content)}
              title={speaking ? "Stop reading" : "Read aloud"}
            >
              {speaking ? "\u25A0 Stop" : "\u25B6 Read"}
            </button>
            <button class="btn btn-sm btn-ghost" onClick={onEdit}>
              Edit
            </button>
            <button class="btn btn-sm btn-ghost" onClick={onClose} title="Close">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>
        <div class="spec-modal-body">
          <MarkdownRenderer content={content} />
        </div>
      </div>
    </div>
  );
}
