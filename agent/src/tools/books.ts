import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import type { TodoRef } from "./lists.js";

const STORAGE_ROOT = path.join("/data", "storage");
const BOOKS_ROOT = path.join(STORAGE_ROOT, "books");
const BOOKS_INDEX = path.join(BOOKS_ROOT, "index.json");

export interface BookPage {
  id: string;
  title: string;
  order: number;
  linked_todos: TodoRef[];
  created_at: string;
  updated_at: string;
}

export interface Book {
  id: string;
  name: string;
  pages: BookPage[];
  created_at: string;
  updated_at: string;
}

export interface BookSummary {
  id: string;
  name: string;
  updated_at: string;
}

function bookDir(bookId: string): string {
  return path.join(BOOKS_ROOT, bookId);
}

function bookMetaPath(bookId: string): string {
  return path.join(bookDir(bookId), "book.json");
}

function pagePath(bookId: string, pageId: string): string {
  return path.join(bookDir(bookId), "pages", `${pageId}.md`);
}

export function ensureBooksDir(): void {
  fs.mkdirSync(BOOKS_ROOT, { recursive: true });
}

export function ensureBookDir(bookId: string): void {
  fs.mkdirSync(path.join(bookDir(bookId), "pages"), { recursive: true });
}

export function loadBooksIndex(): BookSummary[] {
  if (fs.existsSync(BOOKS_INDEX)) {
    try {
      return JSON.parse(fs.readFileSync(BOOKS_INDEX, "utf-8"));
    } catch {}
  }
  return [];
}

export function saveBooksIndex(index: BookSummary[]): void {
  ensureBooksDir();
  fs.writeFileSync(BOOKS_INDEX, JSON.stringify(index, null, 2), "utf-8");
}

export function loadBook(bookId: string): Book | null {
  const file = bookMetaPath(bookId);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      raw.pages = (raw.pages ?? []).map((p: BookPage) => ({
        ...p,
        order: p.order ?? 0,
        linked_todos: p.linked_todos ?? [],
        created_at: p.created_at || "",
        updated_at: p.updated_at || "",
      }));
      return raw;
    } catch {}
  }
  return null;
}

export function saveBook(book: Book): void {
  ensureBookDir(book.id);
  fs.writeFileSync(bookMetaPath(book.id), JSON.stringify(book, null, 2), "utf-8");
}

export function deleteBookDir(bookId: string): void {
  try {
    fs.rmSync(bookDir(bookId), { recursive: true, force: true });
  } catch {}
}

export function loadPage(bookId: string, pageId: string): string {
  try {
    return fs.readFileSync(pagePath(bookId, pageId), "utf-8");
  } catch {
    return "";
  }
}

export function savePage(bookId: string, pageId: string, content: string): void {
  ensureBookDir(bookId);
  fs.writeFileSync(pagePath(bookId, pageId), content, "utf-8");
}

export function deletePageFile(bookId: string, pageId: string): void {
  try {
    fs.unlinkSync(pagePath(bookId, pageId));
  } catch {}
}

function toSummary(book: Book): BookSummary {
  return { id: book.id, name: book.name, updated_at: book.updated_at };
}

export function upsertBookIndex(book: Book): void {
  const index = loadBooksIndex();
  const i = index.findIndex((s) => s.id === book.id);
  if (i >= 0) {
    index[i] = toSummary(book);
  } else {
    index.push(toSummary(book));
  }
  index.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  saveBooksIndex(index);
}

export function removeBookIndex(bookId: string): void {
  const index = loadBooksIndex().filter((s) => s.id !== bookId);
  saveBooksIndex(index);
}

// ── CRUD ──

export function listBooks(): BookSummary[] {
  return loadBooksIndex();
}

export function getBook(bookId: string): Book {
  const book = loadBook(bookId);
  if (!book) throw new Error(`book ${bookId} not found`);
  return book;
}

export function createBook(name: string): Book {
  const now = new Date().toISOString();
  const book: Book = {
    id: randomUUID(),
    name,
    pages: [],
    created_at: now,
    updated_at: now,
  };
  saveBook(book);
  upsertBookIndex(book);
  return book;
}

export function deleteBook(bookId: string): void {
  deleteBookDir(bookId);
  removeBookIndex(bookId);
}

export function addPage(bookId: string, title: string): Book {
  const book = getBook(bookId);
  const now = new Date().toISOString();
  const order = book.pages.reduce((m, p) => Math.max(m, p.order), -1) + 1;
  const pageId = randomUUID();
  book.pages.push({
    id: pageId,
    title,
    order,
    linked_todos: [],
    created_at: now,
    updated_at: now,
  });
  book.updated_at = now;
  savePage(bookId, pageId, "");
  saveBook(book);
  upsertBookIndex(book);
  return book;
}

export function savePageContent(bookId: string, pageId: string, content: string): Book {
  savePage(bookId, pageId, content);
  const book = getBook(bookId);
  const page = book.pages.find((p) => p.id === pageId);
  const now = new Date().toISOString();
  if (page) page.updated_at = now;
  book.updated_at = now;
  saveBook(book);
  upsertBookIndex(book);
  return book;
}

export function updatePageMeta(bookId: string, pageId: string, title: string): Book {
  const book = getBook(bookId);
  const page = book.pages.find((p) => p.id === pageId);
  const now = new Date().toISOString();
  if (page) {
    page.title = title;
    page.updated_at = now;
  }
  book.updated_at = now;
  saveBook(book);
  upsertBookIndex(book);
  return book;
}

export function reorderPages(bookId: string, orderedIds: string[]): Book {
  const book = getBook(bookId);
  orderedIds.forEach((id, idx) => {
    const page = book.pages.find((p) => p.id === id);
    if (page) page.order = idx;
  });
  book.pages.sort((a, b) => a.order - b.order);
  book.updated_at = new Date().toISOString();
  saveBook(book);
  upsertBookIndex(book);
  return book;
}

export function deletePage(bookId: string, pageId: string): Book {
  deletePageFile(bookId, pageId);
  const book = getBook(bookId);
  book.pages = book.pages.filter((p) => p.id !== pageId);
  book.updated_at = new Date().toISOString();
  saveBook(book);
  upsertBookIndex(book);
  return book;
}
