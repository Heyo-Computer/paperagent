import { useEffect, useRef } from "preact/hooks";
import { days, expandedDate, getDateRange, formatDate, dayByDate, expandedTodoId, todayString, isAgentLoading } from "../../state/store";
import { getDaysRangeOffset, saveTodo, updateTodo as updateTodoCmd, deleteTodo as deleteTodoCmd } from "../../api/commands";
import { sendChatMessage, buildSummaryPrompt } from "../../api/chat";
import { TodoItem } from "../todos/TodoItem";
import { AddTodo } from "../todos/AddTodo";
import type { TodoItem as TodoItemType } from "../../types";
import { signal, useSignal } from "@preact/signals";

// Track whether all sections are collapsed (for the toggle button)
const allCollapsed = signal(false);

// Week navigation offset, in weeks (0 = current rolling window). Persists across
// tab switches like the Day view's viewedDate.
const weekOffset = signal(0);

function rangeLabel(dates: string[]): string {
  if (dates.length === 0) return "";
  const first = new Date(dates[0] + "T00:00:00");
  const last = new Date(dates[dates.length - 1] + "T00:00:00");
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(first)} – ${fmt(last)}`;
}

function weekRelativeLabel(o: number): string {
  if (o === 0) return "This week";
  if (o === -1) return "Last week";
  if (o === 1) return "Next week";
  return `${Math.abs(o)} weeks ${o < 0 ? "ago" : "ahead"}`;
}

export function WeekAccordion() {
  const todayRef = useRef<HTMLDivElement>(null);
  const loaded = useSignal(false);

  // Load the day range for the currently-offset week into the shared `days`
  // signal. Offsets are in days relative to today, matching the default window.
  async function loadRange() {
    const o = weekOffset.value;
    const entries = await getDaysRangeOffset(-6 + 7 * o, 1 + 7 * o);
    days.value = entries;
  }

  useEffect(() => {
    loaded.value = false;
    loadRange().catch(() => {
      days.value = getDateRange(7 * weekOffset.value).map((date) => ({ date, todos: [] }));
    }).finally(() => {
      loaded.value = true;
      if (weekOffset.value === 0) {
        requestAnimationFrame(() => {
          todayRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
        });
      }
    });
  }, [weekOffset.value]);

  const dateRange = getDateRange(7 * weekOffset.value);
  const today = todayString();

  function toggleDay(date: string) {
    expandedDate.value = expandedDate.value === date ? "" : date;
    expandedTodoId.value = null;
    allCollapsed.value = false;
  }

  function toggleAll() {
    if (allCollapsed.value || expandedDate.value !== "") {
      // Collapse all
      expandedDate.value = "";
      expandedTodoId.value = null;
      allCollapsed.value = true;
    } else {
      // Expand today
      expandedDate.value = today;
      allCollapsed.value = false;
    }
  }

  async function reload() {
    await loadRange();
  }

  async function handleAdd(date: string, title: string) {
    try {
      await saveTodo(date, title);
      await loadRange();
    } catch (e) {
      console.error("[WeekAccordion] handleAdd FAILED", e);
    }
  }

  async function handleToggle(date: string, todo: TodoItemType) {
    await updateTodoCmd(date, { ...todo, completed: !todo.completed });
    await reload();
  }

  async function handleDelete(date: string, todoId: string) {
    await deleteTodoCmd(date, todoId);
    await reload();
  }

  async function handleUpdate(date: string, todo: TodoItemType) {
    await updateTodoCmd(date, todo);
    await reload();
  }

  async function handleSummarize(date: string, todos: TodoItemType[]) {
    await sendChatMessage(buildSummaryPrompt(date, formatDate(date), todos));
  }

  const hasExpanded = expandedDate.value !== "";

  return (
    <div class="accordion">
      <div class="day-panel-header">
        <button class="day-nav-btn" onClick={() => weekOffset.value--} title="Previous week">&#x2039;</button>
        <div class="day-panel-title">
          <div class="day-panel-weekday">{weekRelativeLabel(weekOffset.value)}</div>
          <div class="day-panel-date">{rangeLabel(dateRange)}</div>
        </div>
        <button class="day-nav-btn" onClick={() => weekOffset.value++} title="Next week">&#x203A;</button>
        {weekOffset.value !== 0 && (
          <button class="btn btn-sm btn-ghost day-today-btn" onClick={() => (weekOffset.value = 0)}>This week</button>
        )}
      </div>

      <div class="accordion-toolbar">
        <button
          class="accordion-collapse-btn"
          onClick={toggleAll}
          title={hasExpanded ? "Collapse all" : "Expand today"}
        >
          {hasExpanded ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6l4-4 4 4" />
              <path d="M4 10l4 4 4-4" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 4l4 4 4-4" />
              <path d="M4 12l4-4 4 4" />
            </svg>
          )}
        </button>
      </div>

      {!loaded.value ? null : dateRange.map((date) => {
        const entry = dayByDate(date);
        const info = formatDate(date);
        const isOpen = expandedDate.value === date;
        const todos = entry?.todos ?? [];
        const count = todos.length;

        return (
          <div key={date} ref={info.isToday ? todayRef : undefined} class={`accordion-section ${isOpen ? "open" : ""}`}>
            <button
              class={`accordion-header ${info.isToday ? "today" : ""}`}
              onClick={() => toggleDay(date)}
            >
              <span class={`accordion-chevron ${isOpen ? "open" : ""}`}>&#9656;</span>
              <span class="accordion-label">
                <span class="accordion-weekday">{info.weekday}</span>
                <span class="accordion-date">{info.display}</span>
              </span>
              {count > 0 && (
                <span
                  class="task-meter"
                  role="img"
                  aria-label={`${count} ${count === 1 ? "task" : "tasks"}`}
                  title={`${count} ${count === 1 ? "task" : "tasks"}`}
                >
                  {Array.from({ length: Math.min(count, 7) }).map((_, i) => (
                    <span key={i} class="task-meter-bar" />
                  ))}
                </span>
              )}
            </button>

            {isOpen && (
              <div class="accordion-body">
                {todos.length > 0 ? (
                  <div class="todo-list">
                    {todos.map((todo) => (
                      <TodoItem
                        key={todo.id}
                        todo={todo}
                        date={date}
                        onToggle={() => handleToggle(date, todo)}
                        onDelete={() => handleDelete(date, todo.id)}
                        onUpdate={(t) => handleUpdate(date, t)}
                      />
                    ))}
                  </div>
                ) : (
                  <div class="accordion-empty">No todos yet</div>
                )}
                {todos.length > 0 && (
                  <button
                    class="btn btn-sm btn-ghost accordion-summarize-btn"
                    onClick={() => handleSummarize(date, todos)}
                    disabled={isAgentLoading.value}
                    title="Ask agent to summarize this day"
                  >
                    Summarize
                  </button>
                )}
                <AddTodo onAdd={(title) => handleAdd(date, title)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
