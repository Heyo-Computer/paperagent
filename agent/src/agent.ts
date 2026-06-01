import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, listDirectory } from "./tools/file.js";
import { execCommand } from "./tools/shell.js";
import { saveTodoSpec, updateTodo, getTodosForDate, getBacklogText, addBacklogItem, moveBacklogToDay } from "./tools/todo.js";
import { saveArtifact, listArtifacts } from "./tools/artifact.js";
import { getCalendarEvents, getCalendarEventById } from "./tools/calendar.js";
import { linkTodoToListItem, unlinkTodoFromListItem, linkTodoToBookPage, unlinkTodoFromBookPage, createPageFromTodo, createListItemFromTodo } from "./tools/links.js";
import { searchIndex, type DocKind, type IndexDoc } from "./tools/search.js";
import {
  listLists,
  getList,
  createList,
  addListItem,
  updateListItem,
  deleteListItem,
  type ListField,
} from "./tools/lists.js";
import {
  listBooks,
  getBook,
  createBook,
  addPage,
  savePageContent,
  loadPage,
  updatePageMeta,
} from "./tools/books.js";
import type { AgentMessage } from "./types.js";
import type { ChatProvider, ProviderMessage, ToolResult, ToolSchema } from "./providers/types.js";
import { AnthropicProvider, wrapUserMessage as anthropicUser } from "./providers/anthropic.js";
import { OpenRouterProvider, wrapUserMessage as openrouterUser } from "./providers/openrouter.js";

const CONFIG_PATH = "/data/config/agent.json";

interface PromptConfig {
  spec_verbosity: "terse" | "normal" | "detailed";
  user_context: string;
}

function loadPromptConfig(): PromptConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    const verbosity = ["terse", "normal", "detailed"].includes(parsed.spec_verbosity)
      ? parsed.spec_verbosity
      : "normal";
    return {
      spec_verbosity: verbosity,
      user_context: typeof parsed.user_context === "string" ? parsed.user_context : "",
    };
  } catch {
    return { spec_verbosity: "normal", user_context: "" };
  }
}

function verbosityInstruction(verbosity: PromptConfig["spec_verbosity"]): string {
  switch (verbosity) {
    case "terse":
      return "When writing specs, be brief and to the point. Use minimal headers and bullet points. Skip preamble and obvious context. Aim for the smallest spec that captures the essential information.";
    case "detailed":
      return "When writing specs, be thorough. Include relevant context, rationale, edge cases, and step-by-step detail where applicable. Err on the side of more information.";
    case "normal":
    default:
      return "When writing specs, use a balanced level of detail — clear and complete without being exhaustive.";
  }
}

/** Render index results into a compact, model-readable block for the /search summary.
 * Each line leads with the result's `token` so the model can echo it verbatim as a chip. */
function renderResultsForModel(results: IndexDoc[], query: string): string {
  if (results.length === 0) {
    return `Search query: "${query}"\n\nResults: (none found)`;
  }
  const lines = results.map((r, i) => {
    const bits = [`${i + 1}. [${r.kind}] ${r.token}`];
    if (r.date) bits.push(`   date: ${r.date}`);
    if (r.snippet) bits.push(`   ${r.snippet}`);
    return bits.join("\n");
  });
  return `Search query: "${query}"\n\nResults (${results.length}):\n${lines.join("\n")}`;
}

const tools: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. The host data directory is mounted at /data.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path under /data (e.g., /data/storage/2026/04/05/day.json)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file under /data.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path under /data" },
        content: { type: "string", description: "File content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description: "List files and directories under /data.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path under /data" },
      },
      required: ["path"],
    },
  },
  {
    name: "exec_command",
    description: "Execute a shell command in the sandbox environment.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "save_spec",
    description:
      "Save a markdown spec for a todo item. This writes the spec file and sets has_spec=true on the todo. " +
      "The date is in YYYY-MM-DD format and the todo_id is the UUID of the todo item.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date of the todo (YYYY-MM-DD)" },
        todo_id: { type: "string", description: "UUID of the todo item" },
        content: { type: "string", description: "Markdown content for the spec" },
      },
      required: ["date", "todo_id", "content"],
    },
  },
  {
    name: "update_todo",
    description: "Update a todo item's title or completed status.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date of the todo (YYYY-MM-DD)" },
        todo_id: { type: "string", description: "UUID of the todo item" },
        title: { type: "string", description: "New title (optional, omit to keep current)" },
        completed: { type: "boolean", description: "New completed status (optional, omit to keep current)" },
      },
      required: ["date", "todo_id"],
    },
  },
  {
    name: "get_todos",
    description: "Get all todo items for a given date. Use this to look up todo IDs and see what the user is working on.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date to query (YYYY-MM-DD). Defaults to today." },
      },
      required: [],
    },
  },
  {
    name: "get_backlog",
    description:
      "List all items in the general (undated) backlog. Returns titles, completion state, and ids. " +
      "Use this when the user asks about backlog items or undated tasks.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "add_backlog_item",
    description: "Add a new item to the general (undated) backlog.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Item title" },
      },
      required: ["title"],
    },
  },
  {
    name: "move_backlog_to_day",
    description:
      "Move a backlog item onto a specific day's todo list. Preserves the item's id and any attached spec. " +
      "Use this when the user wants to schedule a backlog item for a particular date.",
    parameters: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "UUID of the backlog item" },
        date: { type: "string", description: "Target date (YYYY-MM-DD)" },
      },
      required: ["item_id", "date"],
    },
  },
  {
    name: "save_artifact",
    description:
      "Save a reusable file (script, snippet, reference, markdown note) to the artifacts library. " +
      "Updates the index so the file appears in the Artifacts tab. " +
      "Use this for standalone reusable files, NOT for todo-attached docs (use save_spec for those).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Filename (e.g., 'hello.py', 'notes.md'). Just the name, no path." },
        content: { type: "string", description: "File content" },
      },
      required: ["name", "content"],
    },
  },
  {
    name: "list_artifacts",
    description: "List all saved artifacts with their names, sizes, and creation dates.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "calendar_events",
    description:
      "List upcoming Google Calendar events from the local cache. Returns events with id, summary, time, " +
      "location, meeting URL, and attendees. Use this to look up events the user is asking about. " +
      "Defaults to today + next 7 days.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Start date YYYY-MM-DD (defaults to today)" },
        days_ahead: { type: "number", description: "Number of days after start date to include (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "calendar_event",
    description:
      "Fetch full details for a specific calendar event by id. Returns the full event JSON " +
      "(summary, attendees, description, location, meeting URL). Use this when you need complete details " +
      "to craft a spec — e.g., the full description, full attendee list, or meeting agenda.",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event id from calendar_events output" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "link_todo_to_list_item",
    description:
      "Link a todo to an existing list item so they reference each other. Writes the link onto both " +
      "the todo and the list item. Use `date` = the todo's date (YYYY-MM-DD), or empty string for a backlog item.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
      },
      required: ["date", "todo_id", "list_id", "item_id"],
    },
  },
  {
    name: "unlink_todo_from_list_item",
    description: "Remove the link between a todo and a list item (both sides).",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
      },
      required: ["date", "todo_id", "list_id", "item_id"],
    },
  },
  {
    name: "link_todo_to_book_page",
    description:
      "Link a todo to an existing book page so they reference each other. Writes the link onto both " +
      "the todo and the page. Use `date` = the todo's date (YYYY-MM-DD), or empty string for a backlog item.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
      },
      required: ["date", "todo_id", "book_id", "page_id"],
    },
  },
  {
    name: "unlink_todo_from_book_page",
    description: "Remove the link between a todo and a book page (both sides).",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
      },
      required: ["date", "todo_id", "book_id", "page_id"],
    },
  },
  {
    name: "create_page_from_todo",
    description:
      "Create a NEW page in a book from a todo (e.g. log standup notes as a new page in the standup book). " +
      "The page is titled after the todo and seeded with the todo's spec content; the todo and the new page " +
      "are then linked on both sides. Look up the todo with get_todos and the book with list_books/get_book first.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        book_id: { type: "string", description: "UUID of the book to add the page to" },
      },
      required: ["date", "todo_id", "book_id"],
    },
  },
  {
    name: "create_list_item_from_todo",
    description:
      "Create a NEW item (row) in a list from a todo. The list's first text field is defaulted to the todo " +
      "title; the todo and the new item are then linked on both sides. Look up the todo with get_todos and the " +
      "list with list_lists/get_list first.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Todo's date YYYY-MM-DD, or empty string for a backlog item" },
        todo_id: { type: "string", description: "UUID of the todo" },
        list_id: { type: "string", description: "UUID of the list to add the item to" },
      },
      required: ["date", "todo_id", "list_id"],
    },
  },
  {
    name: "list_lists",
    description: "List all of the user's lists (structured tables) with their ids, names, and last-updated times.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_list",
    description:
      "Get a single list by id, including its field definitions and all items (each with its id and values). " +
      "Use this to look up list/item ids before adding, updating, deleting, or linking items.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
      },
      required: ["list_id"],
    },
  },
  {
    name: "create_list",
    description:
      "Create a new list (a structured table). Define its columns via `fields`. Each field has a `key` " +
      "(machine name used in item values), a `label` (display name), and a `kind` " +
      "(one of: text, number, date, bool, select). For `select`, include an `options` string array.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the list" },
        fields: {
          type: "array",
          description: "Column definitions for the list",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Machine name for the field (used as the key in item values)" },
              label: { type: "string", description: "Human-readable column label" },
              kind: {
                type: "string",
                description: "Field type",
                enum: ["text", "number", "date", "bool", "select"],
              },
              options: {
                type: "array",
                description: "Allowed values when kind is 'select'",
                items: { type: "string" },
              },
            },
            required: ["key", "label", "kind"],
          },
        },
      },
      required: ["name"],
    },
  },
  {
    name: "add_list_item",
    description:
      "Add a row to a list. `values` is an object keyed by the list's field keys " +
      "(e.g. { name: \"Acme\", email: \"hi@acme.com\" }). Returns the updated list.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
        values: { type: "object", description: "Field values for the new item, keyed by field key" },
      },
      required: ["list_id", "values"],
    },
  },
  {
    name: "update_list_item",
    description:
      "Update an existing list item's values. `values` replaces the item's values object. " +
      "Look up the item_id with get_list first.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
        values: { type: "object", description: "New field values for the item, keyed by field key" },
      },
      required: ["list_id", "item_id", "values"],
    },
  },
  {
    name: "delete_list_item",
    description: "Delete an item (row) from a list by id. Returns the updated list.",
    parameters: {
      type: "object",
      properties: {
        list_id: { type: "string", description: "UUID of the list" },
        item_id: { type: "string", description: "UUID of the item within the list" },
      },
      required: ["list_id", "item_id"],
    },
  },
  {
    name: "list_books",
    description: "List all of the user's books (collections of markdown pages) with their ids, names, and last-updated times.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_book",
    description:
      "Get a book by id. Returns the book's metadata and table of contents (its pages with their ids, " +
      "titles, and order). Use this to look up page ids before reading or updating a page.",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
      },
      required: ["book_id"],
    },
  },
  {
    name: "create_book",
    description: "Create a new (empty) book. Use add_book_page to add pages afterward.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name of the book" },
      },
      required: ["name"],
    },
  },
  {
    name: "add_book_page",
    description:
      "Add a page to a book. Optionally provide initial markdown `content`. Returns the updated book " +
      "(including the new page's id in its table of contents).",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
        title: { type: "string", description: "Title of the new page" },
        content: { type: "string", description: "Initial markdown content for the page (optional)" },
      },
      required: ["book_id", "title"],
    },
  },
  {
    name: "get_book_page",
    description: "Get a single page's title and markdown content from a book.",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
      },
      required: ["book_id", "page_id"],
    },
  },
  {
    name: "update_book_page",
    description:
      "Update a book page's title and/or markdown content. Omit `title` to keep the current title; " +
      "omit `content` to keep the current content.",
    parameters: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "UUID of the book" },
        page_id: { type: "string", description: "UUID of the page within the book" },
        title: { type: "string", description: "New page title (optional)" },
        content: { type: "string", description: "New markdown content (optional)" },
      },
      required: ["book_id", "page_id"],
    },
  },
  {
    name: "search_content",
    description:
      "Search across everything the user has: todos, specs, backlog, lists+items, books+pages, " +
      "artifacts, and calendar events (including PAST meetings). Use this whenever the user references " +
      "something vaguely or asks where/find/which/when (e.g. \"where did I note the launch date\", " +
      "\"find my Acme list\", \"when did I last meet Hugo\"). This is the only way to find a calendar " +
      "event by keyword or in the past — calendar_events only lists a forward date window. Returns " +
      "ranked matches; each result has kind, title, snippet, ids, and a `token` (an @[..] mention " +
      "string). When you surface a result to the user, echo its `token` verbatim so it renders as a " +
      "clickable chip (calendar tokens render as plain text — there is no calendar chip).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms." },
        kinds: {
          type: "array",
          items: {
            type: "string",
            enum: ["todo", "backlog", "spec", "list", "list_item", "book", "page", "artifact", "calendar"],
          },
          description: "Optional filter — only return results of these kinds.",
        },
        limit: { type: "number", description: "Max results (default 10)." },
      },
      required: ["query"],
    },
  },
];

function pickProvider(): ChatProvider {
  const which = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  if (which === "openrouter") return new OpenRouterProvider();
  return new AnthropicProvider();
}

function wrapUser(provider: ChatProvider, text: string): ProviderMessage {
  return provider.name === "openrouter" ? openrouterUser(text) : anthropicUser(text);
}

export class Agent {
  private provider: ChatProvider;
  private history: ProviderMessage[] = [];

  constructor() {
    this.provider = pickProvider();
    console.log(`Agent using provider=${this.provider.name} model=${this.provider.model}`);
  }

  async chat(userMessage: string): Promise<AgentMessage> {
    // Deterministic /search skill: retrieval runs in code (always hits the index),
    // and the model only summarizes the actual results — so it can never hedge about
    // a "limitation" or silently skip the search.
    const searchMatch = /^\s*\/search\s+([\s\S]+)/i.exec(userMessage);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      if (query) return this.searchAndSummarize(query);
    }

    this.history.push(wrapUser(this.provider, userMessage));

    const today = new Date().toISOString().slice(0, 10);
    const promptConfig = loadPromptConfig();

    let systemPrompt =
      `You are a helpful agent for a todo/task management app. Today is ${today}.\n` +
      "The user's data directory is mounted at /data. The storage structure is:\n" +
      "  /data/storage/YYYY/MM/DD/day.json   — day's todos\n" +
      "  /data/storage/YYYY/MM/DD/specs/{todo-id}.md — spec for a todo\n" +
      "  /data/storage/backlog.json — the general (undated) backlog list\n" +
      "  /data/storage/backlog/specs/{item-id}.md — spec for a backlog item\n" +
      "  /data/storage/lists/{list-id}.json — a list (its fields + items)\n" +
      "  /data/storage/books/{book-id}/book.json — a book's metadata + page table of contents\n" +
      "  /data/storage/books/{book-id}/pages/{page-id}.md — a book page's markdown content\n" +
      "  /data/artifacts/ — reusable files\n\n" +
      "The backlog is the user's general todo list with no due date. Use get_backlog to read it. " +
      "When the user wants to schedule a backlog item for a specific day, use move_backlog_to_day.\n" +
      "When the user mentions a todo with @[title](id:UUID|date:YYYY-MM-DD), use the UUID and date directly.\n" +
      "When the user mentions an artifact with @[name](artifact:relative/path), it lives at " +
      "/data/artifacts/relative/path. If it's a file, use read_file to read its contents; if it's a " +
      "folder, use list_directory to see what's inside (then read_file on specific files) when relevant.\n" +
      "When the user mentions a list with @[name](list:<listId>) or @[name](list:<listId>/<itemId>), " +
      "use the list/item tools with those ids. When the user mentions a book with @[name](book:<bookId>) " +
      "or @[name](book:<bookId>/<pageId>), use the book/page tools with those ids.\n" +
      "When asked to create a spec for a todo, use the save_spec tool — don't write files manually.\n" +
      "When asked to save anything to artifacts (a script, snippet, note, reference, or any file " +
      "the user wants to keep around), you MUST use the save_artifact tool — NOT write_file. " +
      "write_file is for low-level file operations only; save_artifact updates the artifact index " +
      "so the file appears in the user's Artifacts tab. " +
      "save_spec is for todo-attached docs; save_artifact is for standalone reusable files.\n" +
      "When you need to look up todos, use the get_todos tool.\n" +
      "Lists are structured tables and books are collections of markdown pages. You MUST use the " +
      "list_*/book_* tools (list_lists, get_list, create_list, add_list_item, update_list_item, " +
      "delete_list_item, list_books, get_book, create_book, add_book_page, get_book_page, " +
      "update_book_page) to work with them — NOT write_file. Those tools keep the indexes in sync so the " +
      "changes appear in the Lists and Books tabs. Look up list/item and book/page ids with get_list / " +
      "get_book before updating, deleting, or linking.\n" +
      "Todos can be linked to list items and book pages. Use link_todo_to_list_item / link_todo_to_book_page " +
      "(and the unlink_* variants) to connect them — the link is written onto both sides. Pass the todo's date " +
      "(YYYY-MM-DD), or an empty string for a backlog item.\n" +
      "To create a brand-new page or item FROM a todo (e.g. \"log my standup notes as a page in my standup book\"), " +
      "look up the todo with get_todos then call create_page_from_todo / create_list_item_from_todo — these create " +
      "the page/item seeded from the todo and link both sides in one step.\n" +
      "When the user references a meeting or calendar event, use calendar_events to list events in a " +
      "date window and calendar_event to fetch full details (attendees, description, meeting link). " +
      "calendar_events only lists a window of cached events — to find a PAST meeting or look one up by " +
      "keyword/attendee (e.g. \"when did I last meet Hugo\"), use search_content, which indexes all " +
      "cached calendar events including past ones. " +
      "To create a spec for an event, look up the matching todo with get_todos, then call save_spec.\n" +
      "When the user references something vaguely or asks where/find/which/when something is across their " +
      "todos, lists, books, artifacts, or calendar events, use the search_content tool. You MUST echo each result's " +
      "`token` (the @[..] string) verbatim when presenting it, so it renders as a clickable chip. " +
      "Never tell the user you are unable to search a category of their data (e.g. past calendar events) — " +
      "search_content indexes all of it; call it and answer from the results. If it returns nothing, say " +
      "nothing was found rather than claiming you lack access.\n" +
      "Be concise and action-oriented. Prefer using tools over asking the user for information you can look up.\n\n" +
      verbosityInstruction(promptConfig.spec_verbosity);

    if (promptConfig.user_context.trim()) {
      systemPrompt +=
        "\n\nThe user has provided this context about themselves — use it to tailor specs and responses:\n" +
        promptConfig.user_context.trim();
    }

    let turn = await this.provider.chat(systemPrompt, this.history, tools);
    let accumulatedText = turn.text;

    while (turn.toolCalls.length > 0) {
      const results: ToolResult[] = [];
      for (const tc of turn.toolCalls) {
        const result = await this.executeTool(tc.name, tc.input as Record<string, string>);
        results.push({ toolCallId: tc.id, content: result });
      }

      this.appendAssistant(turn.rawAssistant);
      this.history.push(this.provider.buildToolResultMessage(results));

      turn = await this.provider.chat(systemPrompt, this.history, tools);
      if (turn.text) {
        accumulatedText = accumulatedText ? `${accumulatedText}\n${turn.text}` : turn.text;
      }
    }

    this.appendAssistant(turn.rawAssistant);

    return {
      id: randomUUID(),
      role: "assistant",
      content: accumulatedText,
      timestamp: new Date().toISOString(),
    };
  }

  /** Deterministic search skill (/search): query the index in code, then make a
   * single tool-less LLM call to summarize the *actual* results. The model is handed
   * authoritative results and forbidden from claiming a limitation, so retrieval is
   * deterministic and never silently skipped or editorialized away. */
  private async searchAndSummarize(query: string): Promise<AgentMessage> {
    const results = searchIndex(query, { limit: 10 });

    const today = new Date().toISOString().slice(0, 10);
    const searchSystem =
      `You are a helpful assistant for a todo/task management app. Today is ${today}. ` +
      "You are presenting the results of a deterministic search across the user's data — " +
      "todos, specs, backlog, lists, books, artifacts, and calendar events (including PAST " +
      "meetings). The results below were retrieved directly from the index, not by you, and " +
      "are authoritative and complete. Summarize them for the user in 1-3 sentences and echo " +
      "each result's `token` verbatim so it renders as a clickable chip. NEVER claim you can't " +
      "search something (e.g. past calendar events) — if it isn't in the results, it simply " +
      "wasn't found. If there are no results, say so plainly.";

    // Push the query + retrieved results as the user turn so the summary call has the
    // results in context and the conversation stays well-formed for follow-ups.
    this.history.push(wrapUser(this.provider, renderResultsForModel(results, query)));
    const turn = await this.provider.chat(searchSystem, this.history, []);
    this.appendAssistant(turn.rawAssistant);

    return {
      id: randomUUID(),
      role: "assistant",
      content: turn.text,
      timestamp: new Date().toISOString(),
    };
  }

  private appendAssistant(raw: unknown) {
    // `raw` is a ProviderMessage that the provider returned in ChatTurn.rawAssistant
    this.history.push(raw as ProviderMessage);
  }

  private async executeTool(name: string, input: Record<string, string>): Promise<string> {
    try {
      switch (name) {
        case "read_file":
          return readFile(input.path);
        case "write_file":
          return writeFile(input.path, input.content);
        case "list_directory":
          return listDirectory(input.path);
        case "exec_command":
          return execCommand(input.command);
        case "save_spec":
          return saveTodoSpec(input.date, input.todo_id, input.content);
        case "update_todo":
          return updateTodo(input.date, input.todo_id, input.title, input.completed as unknown as boolean | undefined);
        case "get_todos":
          return getTodosForDate(input.date);
        case "get_backlog":
          return getBacklogText();
        case "add_backlog_item":
          return JSON.stringify(addBacklogItem(input.title));
        case "move_backlog_to_day":
          return JSON.stringify(moveBacklogToDay(input.item_id, input.date));
        case "save_artifact":
          return saveArtifact(input.name, input.content);
        case "list_artifacts":
          return listArtifacts();
        case "calendar_events":
          return getCalendarEvents(input.date, input.days_ahead as unknown as number | undefined);
        case "calendar_event":
          return getCalendarEventById(input.event_id);
        case "link_todo_to_list_item":
          return JSON.stringify(linkTodoToListItem(input.date ?? "", input.todo_id, input.list_id, input.item_id));
        case "unlink_todo_from_list_item":
          return JSON.stringify(unlinkTodoFromListItem(input.date ?? "", input.todo_id, input.list_id, input.item_id));
        case "link_todo_to_book_page":
          return JSON.stringify(linkTodoToBookPage(input.date ?? "", input.todo_id, input.book_id, input.page_id));
        case "unlink_todo_from_book_page":
          return JSON.stringify(unlinkTodoFromBookPage(input.date ?? "", input.todo_id, input.book_id, input.page_id));
        case "create_page_from_todo":
          return JSON.stringify(createPageFromTodo(input.date ?? "", input.todo_id, input.book_id));
        case "create_list_item_from_todo":
          return JSON.stringify(createListItemFromTodo(input.date ?? "", input.todo_id, input.list_id));
        case "list_lists":
          return JSON.stringify(listLists());
        case "get_list":
          return JSON.stringify(getList(input.list_id));
        case "create_list":
          return JSON.stringify(createList(input.name, (input.fields as unknown as ListField[]) ?? []));
        case "add_list_item":
          return JSON.stringify(addListItem(input.list_id, (input.values as unknown as Record<string, unknown>) ?? {}));
        case "update_list_item":
          return JSON.stringify(
            updateListItem(input.list_id, {
              id: input.item_id,
              values: (input.values as unknown as Record<string, unknown>) ?? {},
              linked_todos: [],
              created_at: "",
              updated_at: "",
            }),
          );
        case "delete_list_item":
          return JSON.stringify(deleteListItem(input.list_id, input.item_id));
        case "list_books":
          return JSON.stringify(listBooks());
        case "get_book":
          return JSON.stringify(getBook(input.book_id));
        case "create_book":
          return JSON.stringify(createBook(input.name));
        case "add_book_page": {
          let book = addPage(input.book_id, input.title);
          if (input.content != null && input.content !== "") {
            const page = book.pages[book.pages.length - 1];
            book = savePageContent(input.book_id, page.id, input.content);
          }
          return JSON.stringify(book);
        }
        case "get_book_page": {
          const book = getBook(input.book_id);
          const page = book.pages.find((p) => p.id === input.page_id);
          if (!page) throw new Error(`page ${input.page_id} not found`);
          return JSON.stringify({ ...page, content: loadPage(input.book_id, input.page_id) });
        }
        case "update_book_page": {
          let book = getBook(input.book_id);
          if (input.title != null) book = updatePageMeta(input.book_id, input.page_id, input.title);
          if (input.content != null) book = savePageContent(input.book_id, input.page_id, input.content);
          return JSON.stringify(book);
        }
        case "search_content": {
          const raw = (input as Record<string, unknown>).kinds;
          let kinds: DocKind[] | undefined;
          if (Array.isArray(raw)) kinds = raw as DocKind[];
          else if (typeof raw === "string" && raw.trim()) {
            try {
              const parsed = JSON.parse(raw);
              kinds = Array.isArray(parsed) ? (parsed as DocKind[]) : [raw as DocKind];
            } catch {
              kinds = raw.split(/[,\s]+/).filter(Boolean) as DocKind[];
            }
          }
          const limitRaw = (input as Record<string, unknown>).limit;
          const limit = limitRaw != null ? Number(limitRaw) : undefined;
          return JSON.stringify(searchIndex(input.query, { kinds, limit }));
        }
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: unknown) {
      const error = err as Error;
      return `Tool error: ${error.message}`;
    }
  }

  clearHistory() {
    this.history = [];
  }
}
