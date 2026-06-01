import { useEffect } from "preact/hooks";
import { signal } from "@preact/signals";
import { monthDays, expandedTodoId, todayString, viewedDate, activeTab } from "../../state/store";
import { getDaysRangeOffset } from "../../api/commands";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Month navigation offset, in calendar months (0 = current month). Persists
// across tab switches like the Day view's viewedDate.
const monthOffset = signal(0);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function dateStr(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** Get all dates for a calendar grid (includes leading blanks for alignment). */
function getCalendarGrid(year: number, month: number): (string | null)[] {
  const firstDay = new Date(year, month, 1);
  // Monday-based: 0=Mon ... 6=Sun
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(dateStr(year, month, d));
  return cells;
}

export function MonthAccordion() {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() + monthOffset.value, 1);
  const year = base.getFullYear();
  const month = base.getMonth();
  const label = base.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const today = todayString();

  useEffect(() => {
    // Load the whole displayed month as a day offset range relative to today.
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const msPerDay = 86400000;
    const offsetStart = Math.round((new Date(year, month, 1).getTime() - startOfToday.getTime()) / msPerDay);
    const offsetEnd = offsetStart + daysInMonth - 1;
    getDaysRangeOffset(offsetStart, offsetEnd)
      .then((entries) => { monthDays.value = entries; })
      .catch(() => {});
  }, [monthOffset.value]);

  const grid = getCalendarGrid(year, month);

  function entryByDate(date: string) {
    return monthDays.value.find((d) => d.date === date);
  }

  function openDay(d: string) {
    viewedDate.value = d;
    activeTab.value = "day";
    expandedTodoId.value = null;
  }

  return (
    <div class="month-calendar">
      <div class="day-panel-header">
        <button class="day-nav-btn" onClick={() => monthOffset.value--} title="Previous month">&#x2039;</button>
        <div class="day-panel-title">
          <div class="day-panel-weekday">{label}</div>
        </div>
        <button class="day-nav-btn" onClick={() => monthOffset.value++} title="Next month">&#x203A;</button>
        {monthOffset.value !== 0 && (
          <button class="btn btn-sm btn-ghost day-today-btn" onClick={() => (monthOffset.value = 0)}>This month</button>
        )}
      </div>

      <div class="cal-month">
        <div class="cal-grid">
          {DAY_LABELS.map((d) => (
            <div key={d} class="cal-day-header">{d}</div>
          ))}
          {grid.map((ds, i) => {
            if (!ds) return <div key={`empty-${i}`} class="cal-cell cal-empty" />;
            const entry = entryByDate(ds);
            const count = entry?.todos?.length ?? 0;
            const isToday = ds === today;
            const dayNum = new Date(ds + "T00:00:00").getDate();
            const bucket = count <= 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4;
            const heatClass = bucket > 0 ? ` heat-${bucket}` : "";

            return (
              <button
                key={ds}
                class={`cal-cell${isToday ? " cal-today" : ""}${heatClass}`}
                onClick={() => openDay(ds)}
                title={count > 0 ? `${count} ${count === 1 ? "task" : "tasks"}` : undefined}
              >
                <span class="cal-day-num">{dayNum}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
