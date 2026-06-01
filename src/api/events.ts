import { listen } from "@tauri-apps/api/event";
import { agentStatus, setupProgress } from "../state/store";
import type { AgentStatus } from "../types";

export async function setupEventListeners() {
  await listen<string>("agent-status", (event) => {
    agentStatus.value = event.payload as AgentStatus;
  });
  await listen<string>("setup-progress", (event) => {
    setupProgress.value = event.payload;
  });
}
