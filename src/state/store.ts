import { signal } from "@preact/signals";
import type { DayEntry, TodoItem, AgentMessage, Artifact, ViewTab, AgentStatus, AgentMode, ListSummary, BookSummary, LinkRef, TodoRef } from "../types";

// Navigation — tabs above the chat
export const activeTab = signal<ViewTab>("day");

// Accordion — which day is expanded (date string or null)
export const expandedDate = signal<string>(todayString());

// Single date currently focused in the Day tab
export const viewedDate = signal<string>(todayString());

// Days & Todos
export const days = signal<DayEntry[]>([]);
export const monthDays = signal<DayEntry[]>([]);
export const expandedTodoId = signal<string | null>(null);

export function dayByDate(date: string): DayEntry | undefined {
  return days.value.find((d) => d.date === date);
}

// Chat
export const chatMessages = signal<AgentMessage[]>([]);
export const isAgentLoading = signal<boolean>(false);

// Agent
export const agentStatus = signal<AgentStatus>("disconnected");
// Latest provisioning/setup progress message (shown on the boot overlay).
export const setupProgress = signal<string>("");
export const agentMode = signal<AgentMode>("local");
export const deployUrl = signal<string | null>(null);

// Artifacts — `artifacts` is the current-folder view (Artifacts panel);
// `allArtifacts` is the flat recursive list used for @-mention candidates.
export const artifacts = signal<Artifact[]>([]);
export const allArtifacts = signal<Artifact[]>([]);

// Lists — `allLists` is the summary list used for the Lists tab and @-mention candidates (T-009).
export const allLists = signal<ListSummary[]>([]);

// Books — `allBooks` is the summary list used for the Books tab and @-mention candidates (T-009).
export const allBooks = signal<BookSummary[]>([]);

// Cross-tab navigation requests (T-009). Set by a link chip click; the target panel
// reads and clears it to open the requested list/item or book/page.
export const pendingListSelection = signal<{ listId: string; itemId?: string } | null>(null);
export const pendingBookSelection = signal<{ bookId: string; pageId?: string } | null>(null);

// Cross-tab navigation request toward a todo (set by a linked-todo chip click on a
// list item / book page). The Day tab reads and clears it after loading the day.
export const pendingTodoSelection = signal<{ date: string; todoId: string } | null>(null);

// Cross-tab navigation request toward an artifact (set by an artifact chip click in
// chat). The Artifacts tab reads and clears it: cd to the folder, open the file modal.
export const pendingArtifactSelection = signal<{ path: string } | null>(null);

// Cross-tab navigation request toward a backlog (no-due-date) todo. The Backlog tab
// reads and clears it: highlight + scroll the item into view.
export const pendingBacklogSelection = signal<{ todoId: string } | null>(null);

// Navigate to an artifact referenced from a chat chip (data-artifact-path).
export function navigateToArtifact(path: string): void {
  pendingArtifactSelection.value = { path };
  activeTab.value = "artifacts";
}

// Navigate to the target of a todo->list/book link (chip click on a todo).
export function navigateToLink(link: LinkRef): void {
  if (link.kind === "list") {
    pendingListSelection.value = { listId: link.target_id, itemId: link.sub_id };
    activeTab.value = "lists";
  } else {
    pendingBookSelection.value = { bookId: link.target_id, pageId: link.sub_id };
    activeTab.value = "books";
  }
}

// Navigate to a todo referenced from a list item / book page (chip click on a panel).
export function navigateToTodo(ref: TodoRef): void {
  if (ref.date) {
    pendingTodoSelection.value = { date: ref.date, todoId: ref.todo_id };
    activeTab.value = "day";
  } else {
    pendingBacklogSelection.value = { todoId: ref.todo_id };
    activeTab.value = "backlog";
  }
}

// Theme
export const currentThemeName = signal<string>("dark");

// Settings panel
export const settingsOpen = signal<boolean>(false);

// Agent name (mirrors vm_name from config, shown as app title)
export const agentName = signal<string>("planner");

// Status popover
export const statusPopoverOpen = signal<boolean>(false);

// Helpers
export function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Rolling 8-day window ending tomorrow. `shiftDays` slides the whole window
// (used by the Week view's prev/next navigation, which shifts by 7 days).
export function getDateRange(shiftDays = 0): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 6; i >= -1; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i + shiftDays);
    dates.push(formatDateString(d));
  }
  return dates;
}

export function getMonthDateRange(): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 2; i <= 28; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(formatDateString(d));
  }
  return dates;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatDate(dateStr: string): { display: string; weekday: string; isToday: boolean; isTomorrow: boolean } {
  const date = new Date(dateStr + "T00:00:00");
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const isToday = sameDay(date, today);
  const isTomorrow = sameDay(date, tomorrow);

  return {
    display: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    weekday: isToday ? "Today" : isTomorrow ? "Tomorrow" : date.toLocaleDateString("en-US", { weekday: "long" }),
    isToday,
    isTomorrow,
  };
}

// Actions — update days signal when todos change
export function updateDayTodos(date: string, todos: TodoItem[]) {
  const current = days.value;
  const idx = current.findIndex((d) => d.date === date);
  if (idx >= 0) {
    const updated = [...current];
    updated[idx] = { ...updated[idx], todos };
    days.value = updated;
  } else {
    days.value = [...current, { date, todos }];
  }
}

export function updateMonthDayTodos(date: string, todos: TodoItem[]) {
  const current = monthDays.value;
  const idx = current.findIndex((d) => d.date === date);
  if (idx >= 0) {
    const updated = [...current];
    updated[idx] = { ...updated[idx], todos };
    monthDays.value = updated;
  } else {
    monthDays.value = [...current, { date, todos }];
  }
}

// Group dates by calendar week (Mon-Sun) for the month view
export function groupByWeek(dates: string[]): { label: string; dates: string[] }[] {
  if (dates.length === 0) return [];

  const weeks: { label: string; dates: string[] }[] = [];
  let currentDates: string[] = [];
  let currentMondayTime: number | null = null;

  for (const dateStr of dates) {
    const d = new Date(dateStr + "T00:00:00");
    // getDay: 0=Sun, 1=Mon ... 6=Sat → shift so Mon=0
    const dayOfWeek = (d.getDay() + 6) % 7;
    const monday = new Date(d);
    monday.setDate(monday.getDate() - dayOfWeek);
    const mondayTime = monday.getTime();

    if (currentMondayTime !== null && mondayTime !== currentMondayTime) {
      weeks.push({ label: weekLabel(currentDates), dates: currentDates });
      currentDates = [];
    }
    currentDates.push(dateStr);
    currentMondayTime = mondayTime;
  }
  if (currentDates.length > 0) {
    weeks.push({ label: weekLabel(currentDates), dates: currentDates });
  }
  return weeks;
}

function weekLabel(dates: string[]): string {
  const first = new Date(dates[0] + "T00:00:00");
  const last = new Date(dates[dates.length - 1] + "T00:00:00");
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return first.getMonth() === last.getMonth()
    ? `${fmt(first)} - ${last.getDate()}`
    : `${fmt(first)} - ${fmt(last)}`;
}
