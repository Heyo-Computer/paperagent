import { useEffect, useState } from "preact/hooks";
import {
  loadBacklog,
  addBacklogItem,
  updateBacklogItem,
  deleteBacklogItem,
  moveBacklogToDay,
  getDaysRange,
} from "../../api/commands";
import { AddTodo } from "../todos/AddTodo";
import { days, todayString, updateDayTodos, pendingBacklogSelection } from "../../state/store";
import type { Backlog, TodoItem as TodoItemType } from "../../types";

function formatLong(date: string): string {
  const d = new Date(date + "T00:00:00");
  const today = todayString();
  const tomorrow = (() => {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  })();
  const tag = date === today ? " (Today)" : date === tomorrow ? " (Tomorrow)" : "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) + tag;
}

export function BacklogPanel() {
  const [backlog, setBacklog] = useState<Backlog>({ items: [] });
  const [loading, setLoading] = useState(false);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveDate, setMoveDate] = useState<string>(todayString());
  const [highlightId, setHighlightId] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    try {
      const b = await loadBacklog();
      setBacklog(b);
    } catch {
      setBacklog({ items: [] });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  // Honour a cross-tab navigation request (linked-todo / search chip click): highlight
  // the target item; the row ref callback scrolls it into view once rendered.
  useEffect(() => {
    const sel = pendingBacklogSelection.value;
    if (!sel) return;
    pendingBacklogSelection.value = null;
    setHighlightId(sel.todoId);
  }, [pendingBacklogSelection.value]);

  async function handleAdd(title: string) {
    const b = await addBacklogItem(title);
    setBacklog(b);
  }

  async function handleToggle(item: TodoItemType) {
    // Completing a backlog item moves it onto today's list (as done) and out of
    // the backlog. Un-checking a (still-listed) item just toggles it in place.
    if (!item.completed) {
      const today = todayString();
      await updateBacklogItem({ ...item, completed: true });
      const result = await moveBacklogToDay(item.id, today);
      setBacklog(result.backlog);
      updateDayTodos(result.day.date, result.day.todos);
      if (!days.value.some((d) => d.date === result.day.date)) {
        try {
          const entries = await getDaysRange();
          days.value = entries;
        } catch {}
      }
      return;
    }
    const b = await updateBacklogItem({ ...item, completed: !item.completed });
    setBacklog(b);
  }

  async function handleDelete(id: string) {
    const b = await deleteBacklogItem(id);
    setBacklog(b);
  }

  function startMove(id: string) {
    setMovingId(id);
    setMoveDate(todayString());
  }

  function cancelMove() {
    setMovingId(null);
  }

  async function confirmMove() {
    if (!movingId) return;
    const result = await moveBacklogToDay(movingId, moveDate);
    setBacklog(result.backlog);
    setMovingId(null);
    // Update day cache so the week/day view reflects the moved item immediately.
    updateDayTodos(result.day.date, result.day.todos);
    // If the day isn't in the loaded range yet, also refresh it via the full range fetch.
    if (!days.value.some((d) => d.date === result.day.date)) {
      try {
        const entries = await getDaysRange();
        days.value = entries;
      } catch {}
    }
  }

  return (
    <div class="day-panel">
      <div class="day-panel-header">
        <div class="day-panel-title">
          <div class="day-panel-weekday">Backlog</div>
          <div class="day-panel-date">No due date</div>
        </div>
      </div>

      <div class="day-panel-body">
        {loading && backlog.items.length === 0 ? (
          <div class="accordion-empty">Loading...</div>
        ) : backlog.items.length > 0 ? (
          <div class="todo-list">
            {backlog.items.map((item) => (
              <div
                key={item.id}
                class={`todo-item ${highlightId === item.id ? "lists-row-highlight" : ""}`}
                ref={(el) => {
                  if (el && highlightId === item.id) {
                    el.scrollIntoView({ block: "center", behavior: "smooth" });
                  }
                }}
              >
                <div class="todo-item-row">
                  <button
                    class={`todo-checkbox ${item.completed ? "checked" : ""}`}
                    onClick={(e) => { e.stopPropagation(); handleToggle(item); }}
                  />
                  <span class={`todo-title ${item.completed ? "completed" : ""}`}>
                    {item.title}
                  </span>
                  <button
                    class="todo-expand-btn"
                    onClick={(e) => { e.stopPropagation(); startMove(item.id); }}
                    title="Move to a specific day"
                  >
                    Move
                  </button>
                  <button
                    class="todo-expand-btn todo-delete-btn"
                    onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    title="Delete"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6" /><path d="M14 11v6" />
                    </svg>
                  </button>
                </div>
                {movingId === item.id && (
                  <div class="backlog-move-row">
                    <input
                      type="date"
                      value={moveDate}
                      onInput={(e) => setMoveDate(e.currentTarget.value)}
                    />
                    <span class="backlog-move-label">{formatLong(moveDate)}</span>
                    <button class="btn btn-sm btn-secondary" onClick={cancelMove}>Cancel</button>
                    <button class="btn btn-sm btn-primary" onClick={confirmMove}>Move</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div class="accordion-empty">No backlog items yet</div>
        )}
        <AddTodo onAdd={handleAdd} />
      </div>
    </div>
  );
}
