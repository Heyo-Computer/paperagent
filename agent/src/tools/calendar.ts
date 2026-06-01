import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "./paths.js";

const CALENDAR_CACHE = path.join(DATA_DIR, "calendar", "events.json");

interface CalendarEvent {
  id: string;
  summary: string;
  start_time: string;
  end_time: string;
  description: string;
  location: string;
  meeting_url: string;
  attendees: string[];
}

/** Merge freshly-fetched events into the cache (dedupe by id, or start|summary
 * when id is empty; the fetched copy wins), sort by start_time, and persist.
 * Ports services/storage.rs::save_calendar_events so the cache lives in the VM. */
export function saveEvents(events: CalendarEvent[]): { count: number } {
  fs.mkdirSync(path.dirname(CALENDAR_CACHE), { recursive: true });
  const key = (e: CalendarEvent) => (e.id ? e.id : `${e.start_time}|${e.summary}`);
  const merged = loadEvents();
  const index = new Map<string, number>();
  merged.forEach((e, i) => index.set(key(e), i));
  for (const ev of events) {
    const k = key(ev);
    const at = index.get(k);
    if (at !== undefined) merged[at] = ev;
    else {
      index.set(k, merged.length);
      merged.push(ev);
    }
  }
  merged.sort((a, b) => a.start_time.localeCompare(b.start_time));
  fs.writeFileSync(CALENDAR_CACHE, JSON.stringify(merged, null, 2), "utf-8");
  return { count: merged.length };
}

function loadEvents(): CalendarEvent[] {
  if (!fs.existsSync(CALENDAR_CACHE)) return [];
  try {
    const raw = fs.readFileSync(CALENDAR_CACHE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function eventDate(event: CalendarEvent): string {
  if (!event.start_time) return "";
  const datePart = event.start_time.split("T")[0];
  return datePart.length === 10 ? datePart : "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

/**
 * List calendar events in a date range. Defaults to today + next 7 days.
 * Returns a compact text listing with id, summary, time, location, meeting URL, and attendees count.
 */
export function getCalendarEvents(date?: string, daysAhead?: number): string {
  const events = loadEvents();
  if (events.length === 0) {
    return "No calendar events cached. Ask the user to sync calendar from the Status panel.";
  }

  const startDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : localDateStr(new Date());
  const days = typeof daysAhead === "number" && daysAhead >= 0 ? daysAhead : 7;

  const start = new Date(startDate + "T00:00:00");
  const end = new Date(startDate + "T00:00:00");
  end.setDate(end.getDate() + days);
  const endStr = localDateStr(end);

  const filtered = events
    .filter((e) => {
      const d = eventDate(e);
      return d && d >= startDate && d <= endStr;
    })
    .sort((a, b) => a.start_time.localeCompare(b.start_time));

  if (filtered.length === 0) {
    return `No events between ${startDate} and ${endStr}.`;
  }

  return filtered
    .map((e) => {
      const lines = [
        `[${e.id}] ${e.summary}`,
        `  When: ${e.start_time} - ${e.end_time}`,
      ];
      if (e.location) lines.push(`  Where: ${e.location}`);
      if (e.meeting_url) lines.push(`  Meeting: ${e.meeting_url}`);
      if (e.attendees.length > 0) lines.push(`  Attendees (${e.attendees.length}): ${truncate(e.attendees.join(", "), 200)}`);
      if (e.description) lines.push(`  Notes: ${truncate(e.description.replace(/\s+/g, " "), 200)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Fetch full details for a single event by id. Returns the full event JSON for use
 * when crafting a detailed spec.
 */
export function getCalendarEventById(eventId: string): string {
  const events = loadEvents();
  const event = events.find((e) => e.id === eventId);
  if (!event) {
    return `Event '${eventId}' not found in cache. Use calendar_events first to look up valid IDs.`;
  }
  return JSON.stringify(event, null, 2);
}
