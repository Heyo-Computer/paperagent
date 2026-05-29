import { sendMessage, getDaysRange, listArtifacts, listAllArtifacts } from "./commands";
import { chatMessages, isAgentLoading, days, artifacts, allArtifacts } from "../state/store";
import type { TodoItem } from "../types";

let msgCounter = 0;
function localId() { return `local-${Date.now()}-${++msgCounter}`; }

export function buildSummaryPrompt(
  date: string,
  formatted: { weekday: string; display: string },
  todos: TodoItem[]
): string {
  const open = todos.filter((t) => !t.completed);
  const done = todos.filter((t) => t.completed);
  const line = (t: TodoItem) => `- @[${t.title}](id:${t.id}|date:${date})`;

  const parts = [
    `Please summarize my tasks for ${formatted.weekday} (${formatted.display}) and give me actionable suggestions.`,
  ];
  if (open.length > 0) parts.push(`\n\nOpen tasks:\n${open.map(line).join("\n")}`);
  if (done.length > 0) parts.push(`\n\nCompleted tasks:\n${done.map(line).join("\n")}`);
  parts.push("\n\nSuggestions I'm looking for: which items to move to another day, which items would benefit from a spec, and any quick wins I could batch together.");
  return parts.join("");
}

export async function sendChatMessage(text: string): Promise<void> {
  chatMessages.value = [...chatMessages.value, {
    id: localId(), role: "user" as const, content: text, timestamp: new Date().toISOString(),
  }];
  isAgentLoading.value = true;
  try {
    const response = await sendMessage(text);
    chatMessages.value = [...chatMessages.value, response];
    getDaysRange().then((e) => { days.value = e; }).catch(() => {});
    listArtifacts().then((i) => { artifacts.value = i; }).catch(() => {});
    listAllArtifacts().then((a) => { allArtifacts.value = a; }).catch(() => {});
  } catch (err) {
    chatMessages.value = [...chatMessages.value, {
      id: localId(), role: "assistant" as const, content: `${err}`, timestamp: new Date().toISOString(),
    }];
  } finally {
    isAgentLoading.value = false;
  }
}
