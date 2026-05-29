import { getList, saveList, upsertListIndex, addListItem } from "./lists.js";
import type { List } from "./lists.js";
import { getBook, saveBook, upsertBookIndex, addPage, savePage } from "./books.js";
import type { Book } from "./books.js";
import { addLinkToTodo, removeLinkFromTodo, loadDayEntry, loadSpecContent } from "./todo.js";

// Bidirectional links between todos and list items / book pages (T-009).
// Each op writes a LinkRef onto the todo AND a TodoRef onto the item/page,
// keeping both sides consistent. `date` is empty for backlog (undated) todos.

export function linkTodoToListItem(
  date: string,
  todoId: string,
  listId: string,
  itemId: string,
): List {
  const list = getList(listId);
  const item = list.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`item ${itemId} not found in list ${listId}`);
  const todoTitle = addLinkToTodo(date, todoId, {
    kind: "list",
    target_id: listId,
    sub_id: itemId,
    label: list.name,
  });
  if (!item.linked_todos.some((r) => r.todo_id === todoId && r.date === date)) {
    item.linked_todos.push({ date, todo_id: todoId, label: todoTitle });
    item.updated_at = new Date().toISOString();
  }
  list.updated_at = new Date().toISOString();
  saveList(list);
  upsertListIndex(list);
  return list;
}

export function unlinkTodoFromListItem(
  date: string,
  todoId: string,
  listId: string,
  itemId: string,
): List {
  const list = getList(listId);
  const item = list.items.find((i) => i.id === itemId);
  if (item) {
    item.linked_todos = item.linked_todos.filter(
      (r) => !(r.todo_id === todoId && r.date === date),
    );
    item.updated_at = new Date().toISOString();
  }
  list.updated_at = new Date().toISOString();
  saveList(list);
  upsertListIndex(list);
  removeLinkFromTodo(date, todoId, "list", listId, itemId);
  return list;
}

export function linkTodoToBookPage(
  date: string,
  todoId: string,
  bookId: string,
  pageId: string,
): Book {
  const book = getBook(bookId);
  const page = book.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`page ${pageId} not found in book ${bookId}`);
  const todoTitle = addLinkToTodo(date, todoId, {
    kind: "book",
    target_id: bookId,
    sub_id: pageId,
    label: page.title,
  });
  if (!page.linked_todos.some((r) => r.todo_id === todoId && r.date === date)) {
    page.linked_todos.push({ date, todo_id: todoId, label: todoTitle });
    page.updated_at = new Date().toISOString();
  }
  book.updated_at = new Date().toISOString();
  saveBook(book);
  upsertBookIndex(book);
  return book;
}

export function unlinkTodoFromBookPage(
  date: string,
  todoId: string,
  bookId: string,
  pageId: string,
): Book {
  const book = getBook(bookId);
  const page = book.pages.find((p) => p.id === pageId);
  if (page) {
    page.linked_todos = page.linked_todos.filter(
      (r) => !(r.todo_id === todoId && r.date === date),
    );
    page.updated_at = new Date().toISOString();
  }
  book.updated_at = new Date().toISOString();
  saveBook(book);
  upsertBookIndex(book);
  removeLinkFromTodo(date, todoId, "book", bookId, pageId);
  return book;
}

// ── Create-from-todo (T-011) ──

function todoTitle(date: string, todoId: string): string {
  const todo = loadDayEntry(date).todos.find((t) => t.id === todoId);
  if (!todo) throw new Error(`todo ${todoId} not found on ${date}`);
  return todo.title;
}

/** Create a new page in `bookId` seeded from the todo (title + spec body), then link both sides. */
export function createPageFromTodo(
  date: string,
  todoId: string,
  bookId: string,
): { book: Book; page_id: string } {
  const title = todoTitle(date, todoId);
  const spec = loadSpecContent(date, todoId);
  const body = spec.trim() === "" ? `# ${title}\n` : spec;
  let book = addPage(bookId, title);
  const pageId = book.pages[book.pages.length - 1]?.id;
  if (!pageId) throw new Error("failed to create page");
  savePage(bookId, pageId, body);
  book = linkTodoToBookPage(date, todoId, bookId, pageId);
  return { book, page_id: pageId };
}

/** Create a new item in `listId` seeded from the todo title, then link both sides. */
export function createListItemFromTodo(
  date: string,
  todoId: string,
  listId: string,
): { list: List; item_id: string } {
  const title = todoTitle(date, todoId);
  const list = getList(listId);
  const seedField = list.fields.find((f) => f.kind === "text") ?? list.fields[0];
  const values: Record<string, unknown> = {};
  if (seedField) values[seedField.key] = title;
  let updated = addListItem(listId, values);
  const itemId = updated.items[updated.items.length - 1]?.id;
  if (!itemId) throw new Error("failed to create item");
  updated = linkTodoToListItem(date, todoId, listId, itemId);
  return { list: updated, item_id: itemId };
}
