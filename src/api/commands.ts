import { invoke } from "@tauri-apps/api/core";
import type { DayEntry, TodoItem, AgentMessage, Artifact, Theme, AgentConfig, StatusInfo, CalendarConfig, CalendarStatus, CalendarEvent, DeploymentInfo, Backlog, MoveBacklogResult, List, ListField, ListItem, ListSummary, Book, BookSummary, MigrationCounts, MigrationStatsResult, VmInfo } from "../types";

// Storage commands
export async function loadDay(date: string): Promise<DayEntry> {
  return invoke("load_day", { date });
}

export async function getDaysRange(): Promise<DayEntry[]> {
  return invoke("get_days_range");
}

export async function saveTodo(date: string, title: string): Promise<DayEntry> {
  return invoke("save_todo", { date, title });
}

export async function updateTodo(date: string, todo: TodoItem): Promise<DayEntry> {
  return invoke("update_todo", { date, todo });
}

export async function deleteTodo(date: string, todoId: string): Promise<DayEntry> {
  return invoke("delete_todo", { date, todoId });
}

export async function loadSpec(date: string, todoId: string): Promise<string> {
  return invoke("load_spec", { date, todoId });
}

export async function saveSpec(date: string, todoId: string, content: string): Promise<void> {
  return invoke("save_spec", { date, todoId, content });
}

// Backlog (undated) commands
export async function loadBacklog(): Promise<Backlog> {
  return invoke("load_backlog");
}

export async function addBacklogItem(title: string): Promise<Backlog> {
  return invoke("add_backlog_item", { title });
}

export async function updateBacklogItem(item: TodoItem): Promise<Backlog> {
  return invoke("update_backlog_item", { item });
}

export async function deleteBacklogItem(itemId: string): Promise<Backlog> {
  return invoke("delete_backlog_item", { itemId });
}

export async function loadBacklogSpec(itemId: string): Promise<string> {
  return invoke("load_backlog_spec", { itemId });
}

export async function saveBacklogSpec(itemId: string, content: string): Promise<void> {
  return invoke("save_backlog_spec", { itemId, content });
}

export async function moveBacklogToDay(itemId: string, date: string): Promise<MoveBacklogResult> {
  return invoke("move_backlog_to_day", { itemId, date });
}

// Lists commands
export async function listLists(): Promise<ListSummary[]> {
  return invoke("list_lists");
}

export async function loadList(listId: string): Promise<List> {
  return invoke("load_list", { listId });
}

export async function createList(name: string, fields: ListField[]): Promise<List> {
  return invoke("create_list", { name, fields });
}

export async function updateListMeta(listId: string, name: string, fields: ListField[]): Promise<List> {
  return invoke("update_list_meta", { listId, name, fields });
}

export async function deleteList(listId: string): Promise<void> {
  return invoke("delete_list", { listId });
}

export async function addListItem(listId: string, values: Record<string, unknown>): Promise<List> {
  return invoke("add_list_item", { listId, values });
}

export async function updateListItem(listId: string, item: ListItem): Promise<List> {
  return invoke("update_list_item", { listId, item });
}

export async function deleteListItem(listId: string, itemId: string): Promise<List> {
  return invoke("delete_list_item", { listId, itemId });
}

// Books commands
export async function listBooks(): Promise<BookSummary[]> {
  return invoke("list_books");
}

export async function loadBook(bookId: string): Promise<Book> {
  return invoke("load_book", { bookId });
}

export async function createBook(name: string): Promise<Book> {
  return invoke("create_book", { name });
}

export async function deleteBook(bookId: string): Promise<void> {
  return invoke("delete_book", { bookId });
}

export async function addPage(bookId: string, title: string): Promise<Book> {
  return invoke("add_page", { bookId, title });
}

export async function loadPage(bookId: string, pageId: string): Promise<string> {
  return invoke("load_page", { bookId, pageId });
}

export async function savePage(bookId: string, pageId: string, content: string): Promise<Book> {
  return invoke("save_page", { bookId, pageId, content });
}

export async function updatePageMeta(bookId: string, pageId: string, title: string): Promise<Book> {
  return invoke("update_page_meta", { bookId, pageId, title });
}

export async function reorderPages(bookId: string, orderedIds: string[]): Promise<Book> {
  return invoke("reorder_pages", { bookId, orderedIds });
}

export async function deletePage(bookId: string, pageId: string): Promise<Book> {
  return invoke("delete_page", { bookId, pageId });
}

// Links (bidirectional todo <-> list item / book page). `date` is empty for backlog todos.
export async function linkTodoToListItem(date: string, todoId: string, listId: string, itemId: string): Promise<List> {
  return invoke("link_todo_to_list_item", { date, todoId, listId, itemId });
}

export async function unlinkTodoFromListItem(date: string, todoId: string, listId: string, itemId: string): Promise<List> {
  return invoke("unlink_todo_from_list_item", { date, todoId, listId, itemId });
}

export async function linkTodoToBookPage(date: string, todoId: string, bookId: string, pageId: string): Promise<Book> {
  return invoke("link_todo_to_book_page", { date, todoId, bookId, pageId });
}

export async function unlinkTodoFromBookPage(date: string, todoId: string, bookId: string, pageId: string): Promise<Book> {
  return invoke("unlink_todo_from_book_page", { date, todoId, bookId, pageId });
}

// Create a new page / list item FROM a todo, seeded from it and linked on both sides (T-011).
export async function createPageFromTodo(date: string, todoId: string, bookId: string): Promise<{ book: Book; page_id: string }> {
  return invoke("create_page_from_todo", { date, todoId, bookId });
}

export async function createListItemFromTodo(date: string, todoId: string, listId: string): Promise<{ list: List; item_id: string }> {
  return invoke("create_list_item_from_todo", { date, todoId, listId });
}

// Migration — move local-filesystem data into the sandbox
export async function migrateLocalToSandbox(): Promise<MigrationCounts> {
  return invoke("migrate_local_to_sandbox");
}

export async function migrationStats(): Promise<MigrationStatsResult> {
  return invoke("migration_stats");
}

// Reconstruct the local ~/.todo directory from the sandbox's current data.
export async function exportSandboxToLocal(): Promise<MigrationCounts> {
  return invoke("export_sandbox_to_local");
}

// Theme commands
export async function getTheme(): Promise<Theme> {
  return invoke("get_theme");
}

export async function setTheme(themeName: string): Promise<void> {
  return invoke("set_theme", { themeName });
}

// heyvm commands
export async function createVm(): Promise<string> {
  return invoke("create_vm");
}

export async function startVm(): Promise<boolean> {
  return invoke("start_vm");
}

export async function stopVm(): Promise<boolean> {
  return invoke("stop_vm");
}

export async function vmStatus(): Promise<string> {
  return invoke("vm_status");
}

export async function listSandboxes(): Promise<string[]> {
  return invoke("list_sandboxes");
}

// List all VMs (running + stopped) for the "use existing VM" picker.
export async function listVms(): Promise<VmInfo[]> {
  return invoke("list_vms");
}

// Adopt an existing (e.g. synced) VM as the agent and connect to it.
export async function useExistingVm(vmName: string): Promise<string> {
  return invoke("use_existing_vm", { vmName });
}

// Agent commands
export async function setupAgent(): Promise<string> {
  return invoke("setup_agent");
}

export async function startAgent(): Promise<void> {
  return invoke("start_agent");
}

export async function stopAgent(): Promise<void> {
  return invoke("stop_agent");
}

export async function updateAgent(): Promise<string> {
  return invoke("update_agent");
}

export async function sendMessage(message: string): Promise<AgentMessage> {
  return invoke("send_message", { message });
}

export async function getAgentStatus(): Promise<string> {
  return invoke("agent_status");
}

export async function getChatHistory(date: string): Promise<AgentMessage[]> {
  return invoke("get_chat_history", { date });
}

// Artifact commands
export async function listArtifacts(dir?: string): Promise<Artifact[]> {
  return invoke("list_artifacts", { dir: dir ?? "" });
}

// Flattened recursive listing of every file and folder — used for @-mentions.
export async function listAllArtifacts(): Promise<Artifact[]> {
  return invoke("list_all_artifacts");
}

export async function readArtifact(path: string): Promise<string> {
  return invoke("read_artifact", { path });
}

export async function saveArtifact(path: string, content: string): Promise<Artifact> {
  return invoke("save_artifact", { path, content });
}

export async function deleteArtifact(path: string): Promise<void> {
  return invoke("delete_artifact", { path });
}

export async function createArtifactFolder(path: string): Promise<Artifact> {
  return invoke("create_artifact_folder", { path });
}

export async function renameArtifact(path: string, newName: string): Promise<Artifact> {
  return invoke("rename_artifact", { path, newName });
}

export async function moveArtifact(path: string, targetDir: string): Promise<Artifact> {
  return invoke("move_artifact", { path, targetDir });
}

export async function listArtifactFolders(): Promise<string[]> {
  return invoke("list_artifact_folders");
}

// Config commands
export async function getAgentConfig(): Promise<AgentConfig> {
  return invoke("get_agent_config");
}

export async function setAgentConfig(config: AgentConfig): Promise<void> {
  return invoke("set_agent_config", { config });
}

export async function getStatusInfo(): Promise<StatusInfo> {
  return invoke("get_status_info");
}

export async function getRecentLogs(lines?: number): Promise<string> {
  return invoke("get_recent_logs", { lines });
}

// Calendar commands
export async function getCalendarConfig(): Promise<CalendarConfig> {
  return invoke("get_calendar_config");
}

export async function setCalendarConfig(config: CalendarConfig): Promise<void> {
  return invoke("set_calendar_config", { config });
}

export async function getCalendarStatus(): Promise<CalendarStatus> {
  return invoke("get_calendar_status");
}

export async function connectGoogleCalendar(): Promise<string> {
  return invoke("connect_google_calendar");
}

export async function disconnectGoogleCalendar(): Promise<void> {
  return invoke("disconnect_google_calendar");
}

export async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  return invoke("fetch_calendar_events");
}

export async function syncCalendarToTodos(): Promise<string> {
  return invoke("sync_calendar_to_todos");
}

// Month range
export async function getMonthRange(): Promise<DayEntry[]> {
  return invoke("get_month_range");
}

// Arbitrary day range (offsets in days relative to today) — backs Week/Month nav.
export async function getDaysRangeOffset(offsetStart: number, offsetEnd: number): Promise<DayEntry[]> {
  return invoke("get_days_range_offset", { offsetStart, offsetEnd });
}

// Speech commands
export async function transcribeAudio(audioData: string, mediaType: string): Promise<string> {
  return invoke("transcribe_audio", { audioData, mediaType });
}

export async function transcribeFile(filePath: string): Promise<string> {
  return invoke("transcribe_file", { filePath });
}

export async function speakText(text: string): Promise<string> {
  return invoke("speak_text", { text });
}

export async function describeImage(imageData: string, mediaType: string, prompt: string): Promise<string> {
  return invoke("describe_image", { imageData, mediaType, prompt });
}

// Deploy commands
export async function deployAgent(): Promise<string> {
  return invoke("deploy_agent");
}

export async function connectRemote(url: string): Promise<string> {
  return invoke("connect_remote", { url });
}

export async function disconnectRemote(): Promise<void> {
  return invoke("disconnect_remote");
}

export async function teardownDeploy(): Promise<void> {
  return invoke("teardown_deploy");
}

export async function getDeploymentInfo(): Promise<DeploymentInfo> {
  return invoke("get_deployment_info");
}

// P2P commands — connect to a sandbox shared over iroh via a heyo:// ticket.
export async function connectP2p(ticket: string, relay?: string): Promise<string> {
  return invoke("connect_p2p", { ticket, relay: relay ?? null });
}

export async function disconnectP2p(): Promise<void> {
  return invoke("disconnect_p2p");
}
