import express from "express";
import { Agent } from "./agent.js";
import { makeResponse, makeError } from "./types.js";
import type { AcpRequest } from "./types.js";
import {
  loadDayEntry,
  loadDaysRange,
  addTodo,
  updateTodoEntry,
  deleteTodo,
  loadSpecContent,
  saveTodoSpec,
  loadBacklog,
  addBacklogItem,
  updateBacklogEntry,
  deleteBacklogItem,
  loadBacklogSpec,
  saveBacklogSpecContent,
  moveBacklogToDay,
} from "./tools/todo.js";
import {
  listLists,
  getList,
  createList,
  updateListMeta,
  deleteList,
  addListItem,
  updateListItem,
  deleteListItem,
} from "./tools/lists.js";
import type { ListField, ListItem } from "./tools/lists.js";
import {
  listBooks,
  getBook,
  createBook,
  deleteBook,
  addPage,
  loadPage,
  savePageContent,
  updatePageMeta,
  reorderPages,
  deletePage,
} from "./tools/books.js";
import {
  linkTodoToListItem,
  unlinkTodoFromListItem,
  linkTodoToBookPage,
  unlinkTodoFromBookPage,
  createPageFromTodo,
  createListItemFromTodo,
} from "./tools/links.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8080);

app.use(express.json());

const agent = new Agent();

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ACP JSON-RPC endpoint
app.post("/rpc", async (req, res) => {
  const request = req.body as AcpRequest;

  if (!request.jsonrpc || request.jsonrpc !== "2.0" || !request.method) {
    res.status(400).json(makeError(request?.id ?? 0, -32600, "Invalid JSON-RPC request"));
    return;
  }

  try {
    const p = request.params as Record<string, unknown>;

    switch (request.method) {
      case "agent/chat": {
        const message = p?.message as string | undefined;
        if (!message) {
          res.json(makeError(request.id, -32602, "Missing 'message' parameter"));
          return;
        }
        const response = await agent.chat(message);
        res.json(makeResponse(request.id, response));
        break;
      }

      case "agent/status": {
        res.json(makeResponse(request.id, { status: "running" }));
        break;
      }

      case "agent/clear": {
        agent.clearHistory();
        res.json(makeResponse(request.id, { cleared: true }));
        break;
      }

      case "agent/stop": {
        res.json(makeResponse(request.id, { stopping: true }));
        setTimeout(() => process.exit(0), 100);
        break;
      }

      // ── Storage RPCs ──

      case "storage/load_day": {
        const date = p.date as string;
        res.json(makeResponse(request.id, loadDayEntry(date)));
        break;
      }

      case "storage/load_days_range": {
        const offsetStart = (p.offset_start as number) ?? -6;
        const offsetEnd = (p.offset_end as number) ?? 1;
        res.json(makeResponse(request.id, loadDaysRange(offsetStart, offsetEnd)));
        break;
      }

      case "storage/add_todo": {
        const date = p.date as string;
        const title = p.title as string;
        res.json(makeResponse(request.id, addTodo(date, title)));
        break;
      }

      case "storage/update_todo": {
        const date = p.date as string;
        const todo = p.todo as { id: string; title: string; completed: boolean; has_spec: boolean; created_at: string; updated_at: string };
        res.json(makeResponse(request.id, updateTodoEntry(date, todo)));
        break;
      }

      case "storage/delete_todo": {
        const date = p.date as string;
        const todoId = p.todo_id as string;
        res.json(makeResponse(request.id, deleteTodo(date, todoId)));
        break;
      }

      case "storage/load_spec": {
        const date = p.date as string;
        const todoId = p.todo_id as string;
        res.json(makeResponse(request.id, loadSpecContent(date, todoId)));
        break;
      }

      case "storage/save_spec": {
        const date = p.date as string;
        const todoId = p.todo_id as string;
        const content = p.content as string;
        saveTodoSpec(date, todoId, content);
        res.json(makeResponse(request.id, { ok: true }));
        break;
      }

      case "storage/load_backlog": {
        res.json(makeResponse(request.id, loadBacklog()));
        break;
      }

      case "storage/add_backlog_item": {
        const title = p.title as string;
        res.json(makeResponse(request.id, addBacklogItem(title)));
        break;
      }

      case "storage/update_backlog_item": {
        const item = p.item as { id: string; title: string; completed: boolean; has_spec: boolean; created_at: string; updated_at: string };
        res.json(makeResponse(request.id, updateBacklogEntry(item)));
        break;
      }

      case "storage/delete_backlog_item": {
        const itemId = p.item_id as string;
        res.json(makeResponse(request.id, deleteBacklogItem(itemId)));
        break;
      }

      case "storage/load_backlog_spec": {
        const itemId = p.item_id as string;
        res.json(makeResponse(request.id, loadBacklogSpec(itemId)));
        break;
      }

      case "storage/save_backlog_spec": {
        const itemId = p.item_id as string;
        const content = p.content as string;
        saveBacklogSpecContent(itemId, content);
        res.json(makeResponse(request.id, { ok: true }));
        break;
      }

      case "storage/move_backlog_to_day": {
        const itemId = p.item_id as string;
        const date = p.date as string;
        res.json(makeResponse(request.id, moveBacklogToDay(itemId, date)));
        break;
      }

      // ── Lists RPCs ──

      case "lists/list_lists": {
        res.json(makeResponse(request.id, listLists()));
        break;
      }

      case "lists/load_list": {
        res.json(makeResponse(request.id, getList(p.list_id as string)));
        break;
      }

      case "lists/create_list": {
        const name = p.name as string;
        const fields = (p.fields as ListField[]) ?? [];
        res.json(makeResponse(request.id, createList(name, fields)));
        break;
      }

      case "lists/update_list_meta": {
        const listId = p.list_id as string;
        const name = p.name as string;
        const fields = (p.fields as ListField[]) ?? [];
        res.json(makeResponse(request.id, updateListMeta(listId, name, fields)));
        break;
      }

      case "lists/delete_list": {
        deleteList(p.list_id as string);
        res.json(makeResponse(request.id, { ok: true }));
        break;
      }

      case "lists/add_list_item": {
        const listId = p.list_id as string;
        const values = (p.values as Record<string, unknown>) ?? {};
        res.json(makeResponse(request.id, addListItem(listId, values)));
        break;
      }

      case "lists/update_list_item": {
        const listId = p.list_id as string;
        const item = p.item as ListItem;
        res.json(makeResponse(request.id, updateListItem(listId, item)));
        break;
      }

      case "lists/delete_list_item": {
        const listId = p.list_id as string;
        const itemId = p.item_id as string;
        res.json(makeResponse(request.id, deleteListItem(listId, itemId)));
        break;
      }

      // ── Books RPCs ──

      case "books/list_books": {
        res.json(makeResponse(request.id, listBooks()));
        break;
      }

      case "books/load_book": {
        res.json(makeResponse(request.id, getBook(p.book_id as string)));
        break;
      }

      case "books/create_book": {
        res.json(makeResponse(request.id, createBook(p.name as string)));
        break;
      }

      case "books/delete_book": {
        deleteBook(p.book_id as string);
        res.json(makeResponse(request.id, { ok: true }));
        break;
      }

      case "books/add_page": {
        res.json(makeResponse(request.id, addPage(p.book_id as string, p.title as string)));
        break;
      }

      case "books/load_page": {
        res.json(makeResponse(request.id, loadPage(p.book_id as string, p.page_id as string)));
        break;
      }

      case "books/save_page": {
        res.json(makeResponse(request.id, savePageContent(p.book_id as string, p.page_id as string, p.content as string)));
        break;
      }

      case "books/update_page_meta": {
        res.json(makeResponse(request.id, updatePageMeta(p.book_id as string, p.page_id as string, p.title as string)));
        break;
      }

      case "books/reorder_pages": {
        res.json(makeResponse(request.id, reorderPages(p.book_id as string, (p.ordered_ids as string[]) ?? [])));
        break;
      }

      case "books/delete_page": {
        res.json(makeResponse(request.id, deletePage(p.book_id as string, p.page_id as string)));
        break;
      }

      // ── Links RPCs ──

      case "links/link_todo_to_list_item": {
        res.json(makeResponse(request.id, linkTodoToListItem(p.date as string, p.todo_id as string, p.list_id as string, p.item_id as string)));
        break;
      }

      case "links/unlink_todo_from_list_item": {
        res.json(makeResponse(request.id, unlinkTodoFromListItem(p.date as string, p.todo_id as string, p.list_id as string, p.item_id as string)));
        break;
      }

      case "links/link_todo_to_book_page": {
        res.json(makeResponse(request.id, linkTodoToBookPage(p.date as string, p.todo_id as string, p.book_id as string, p.page_id as string)));
        break;
      }

      case "links/unlink_todo_from_book_page": {
        res.json(makeResponse(request.id, unlinkTodoFromBookPage(p.date as string, p.todo_id as string, p.book_id as string, p.page_id as string)));
        break;
      }

      case "links/create_page_from_todo": {
        res.json(makeResponse(request.id, createPageFromTodo(p.date as string, p.todo_id as string, p.book_id as string)));
        break;
      }

      case "links/create_list_item_from_todo": {
        res.json(makeResponse(request.id, createListItemFromTodo(p.date as string, p.todo_id as string, p.list_id as string)));
        break;
      }

      default:
        res.json(makeError(request.id, -32601, `Method not found: ${request.method}`));
    }
  } catch (err: unknown) {
    const error = err as Error;
    res.json(makeError(request.id, -32603, error.message));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent service listening on port ${PORT}`);
});
