import { useEffect } from "preact/hooks";
import { monthDays, expandedTodoId, todayString, viewedDate, activeTab } from "../../state/store";
import { getMonthRange } from "../../api/commands";

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Build full calendar months that cover the month range (day+2 to day+28). */
function getCalendarMonths(): { year: number; month: number; label: string }[] {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() + 2);
  const end = new Date(now);
  end.setDate(end.getDate() + 28);

  const months: { year: number; month: number; label: string }[] = [];
  let y = start.getFullYear(), m = start.getMonth();
  while (y < end.getFullYear() || (y === end.getFullYear() && m <= end.getMonth())) {
    const label = new Date(y, m, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
    months.push({ year: y, month: m, label });
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return months;
}

/** Get all dates for a calendar grid (includes leading/trailing days from adjacent months). */
function getCalendarGrid(year: number, month: number): (string | null)[] {
  const firstDay = new Date(year, month, 1);
  // Monday-based: 0=Mon ... 6=Sun
  const startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    cells.push(`${yyyy}-${mm}-${dd}`);
  }
  return cells;
}

/** Check if a date string is within the active month range (day+2 to day+28). */
function isInRange(dateStr: string): boolean {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() + 2);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setDate(end.getDate() + 28);
  end.setHours(23, 59, 59, 999);
  const d = new Date(dateStr + "T00:00:00");
  return d >= start && d <= end;
}

export function MonthAccordion() {
  useEffect(() => {
    getMonthRange().then((entries) => {
      monthDays.value = entries;
    }).catch(() => {});
  }, []);

  const calendarMonths = getCalendarMonths();
  const today = todayString();

  function entryByDate(date: string) {
    return monthDays.value.find((d) => d.date === date);
  }

  function openDay(dateStr: string) {
    viewedDate.value = dateStr;
    activeTab.value = "day";
    expandedTodoId.value = null;
  }

  return (
    <div class="month-calendar">
      {calendarMonths.map(({ year, month, label }) => {
        const grid = getCalendarGrid(year, month);
        return (
          <div key={`${year}-${month}`} class="cal-month">
            <div class="cal-month-label">{label}</div>
            <div class="cal-grid">
              {DAY_LABELS.map((d) => (
                <div key={d} class="cal-day-header">{d}</div>
              ))}
              {grid.map((dateStr, i) => {
                if (!dateStr) return <div key={`empty-${i}`} class="cal-cell cal-empty" />;
                const inRange = isInRange(dateStr);
                const entry = entryByDate(dateStr);
                const count = entry?.todos?.length ?? 0;
                const isToday = dateStr === today;
                const dayNum = new Date(dateStr + "T00:00:00").getDate();
                const bucket = count <= 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4;
                const heatClass = inRange && bucket > 0 ? ` heat-${bucket}` : "";

                return (
                  <button
                    key={dateStr}
                    class={`cal-cell${inRange ? "" : " cal-out"}${isToday ? " cal-today" : ""}${heatClass}`}
                    onClick={() => { if (inRange) openDay(dateStr); }}
                    disabled={!inRange}
                    title={count > 0 ? `${count} ${count === 1 ? "task" : "tasks"}` : undefined}
                  >
                    <span class="cal-day-num">{dayNum}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
