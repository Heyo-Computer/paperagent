import { useEffect, useState } from "preact/hooks";
import { viewedDate, todayString, formatDate, expandedTodoId, isAgentLoading, updateDayTodos, pendingTodoSelection } from "../../state/store";
import { sendChatMessage, buildSummaryPrompt } from "../../api/chat";
import { loadDay, saveTodo, updateTodo as updateTodoCmd, deleteTodo as deleteTodoCmd } from "../../api/commands";
import { TodoItem } from "../todos/TodoItem";
import { AddTodo } from "../todos/AddTodo";
import { useReadAloud } from "../../hooks/useReadAloud";
import type { DayEntry, TodoItem as TodoItemType } from "../../types";

function buildSummary(weekday: string, todos: TodoItemType[]): string {
  if (todos.length === 0) return `No todos for ${weekday}.`;
  const pending = todos.filter((t) => !t.completed);
  const done = todos.length - pending.length;
  const titles = todos.map((t) => t.title.trim()).filter(Boolean);
  const list = titles.join(". ");
  const header = `${todos.length} ${todos.length === 1 ? "todo" : "todos"} for ${weekday}`;
  const trailer = done > 0 ? ` ${done} completed.` : "";
  return `${header}: ${list}.${trailer}`;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function DayPanel() {
  const date = viewedDate.value;
  const [entry, setEntry] = useState<DayEntry | null>(null);
  const [loading, setLoading] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const e = await loadDay(date);
      setEntry(e);
      // Mirror into the shared signal so @-mentions reflect this day's edits.
      updateDayTodos(date, e.todos);
    } catch {
      setEntry({ date, todos: [] });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    const sel = pendingTodoSelection.value;
    if (sel && sel.date === date) {
      expandedTodoId.value = sel.todoId;
      pendingTodoSelection.value = null;
    } else {
      expandedTodoId.value = null;
    }
  }, [date]);

  // A linked-todo chip on another tab requested this todo; switch day if needed.
  useEffect(() => {
    const sel = pendingTodoSelection.value;
    if (!sel) return;
    if (sel.date !== viewedDate.value) {
      viewedDate.value = sel.date; // triggers the [date] effect, which expands + clears
    } else {
      expandedTodoId.value = sel.todoId;
      pendingTodoSelection.value = null;
    }
  }, [pendingTodoSelection.value]);

  async function handleAdd(title: string) {
    await saveTodo(date, title);
    reload();
  }

  async function handleToggle(todo: TodoItemType) {
    await updateTodoCmd(date, { ...todo, completed: !todo.completed });
    reload();
  }

  async function handleDelete(todoId: string) {
    await deleteTodoCmd(date, todoId);
    reload();
  }

  async function handleUpdate(todo: TodoItemType) {
    await updateTodoCmd(date, todo);
    reload();
  }

  function goPrev() { viewedDate.value = shiftDate(date, -1); }
  function goNext() { viewedDate.value = shiftDate(date, 1); }
  function goToday() { viewedDate.value = todayString(); }

  const today = todayString();
  const isToday = date === today;
  const formatted = formatDate(date);
  const todos = entry?.todos ?? [];
  const { speaking, toggle: toggleSpeak, stop: stopSpeak } = useReadAloud();

  async function handleSummarize() {
    await sendChatMessage(buildSummaryPrompt(date, formatted, todos));
  }

  useEffect(() => () => stopSpeak(), []);
  useEffect(() => { stopSpeak(); }, [date]);

  return (
    <div class="day-panel">
      <div class="day-panel-header">
        <button class="day-nav-btn" onClick={goPrev} title="Previous day">&#x2039;</button>
        <div class="day-panel-title">
          <div class="day-panel-weekday">{formatted.weekday}</div>
          <div class="day-panel-date">{formatted.display}</div>
        </div>
        <button class="day-nav-btn" onClick={goNext} title="Next day">&#x203A;</button>
        <button
          class={`day-nav-btn day-summary-btn${speaking ? " speaking" : ""}`}
          onClick={() => toggleSpeak(buildSummary(formatted.weekday, todos))}
          title={speaking ? "Stop reading" : "Read summary"}
          disabled={loading}
        >
          {speaking ? "\u25A0" : "\u25B6"}
        </button>
        <button
          class="day-nav-btn day-ai-summary-btn"
          onClick={handleSummarize}
          disabled={loading || isAgentLoading.value || todos.length === 0}
          title="Ask agent to summarize this day"
        >
          &#10024;
        </button>
        {!isToday && (
          <button class="btn btn-sm btn-ghost day-today-btn" onClick={goToday}>Today</button>
        )}
      </div>

      <div class="day-panel-body">
        {loading && todos.length === 0 ? (
          <div class="accordion-empty">Loading...</div>
        ) : todos.length > 0 ? (
          <div class="todo-list">
            {todos.map((todo) => (
              <TodoItem
                key={todo.id}
                todo={todo}
                date={date}
                onToggle={() => handleToggle(todo)}
                onDelete={() => handleDelete(todo.id)}
                onUpdate={(t) => handleUpdate(t)}
              />
            ))}
          </div>
        ) : (
          <div class="accordion-empty">No todos yet</div>
        )}
        <AddTodo onAdd={handleAdd} />
      </div>
    </div>
  );
}
