import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { STORAGE_DIR } from "./paths.js";

const LISTS_ROOT = path.join(STORAGE_DIR, "lists");
const LISTS_INDEX = path.join(LISTS_ROOT, "index.json");

export type FieldKind = "text" | "number" | "date" | "bool" | "select";

export interface ListField {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[] | null;
}

export interface TodoRef {
  date: string;
  todo_id: string;
  label?: string;
}

export interface ListItem {
  id: string;
  values: Record<string, unknown>;
  linked_todos: TodoRef[];
  /** Soft-hide flag. Archived items are kept but hidden from the default view. */
  archived?: boolean;
  created_at: string;
  updated_at: string;
}

export interface List {
  id: string;
  name: string;
  fields: ListField[];
  items: ListItem[];
  created_at: string;
  updated_at: string;
}

export interface ListSummary {
  id: string;
  name: string;
  updated_at: string;
}

function listPath(listId: string): string {
  return path.join(LISTS_ROOT, `${listId}.json`);
}

export function ensureListsDir(): void {
  fs.mkdirSync(LISTS_ROOT, { recursive: true });
}

export function loadListsIndex(): ListSummary[] {
  if (fs.existsSync(LISTS_INDEX)) {
    try {
      return JSON.parse(fs.readFileSync(LISTS_INDEX, "utf-8"));
    } catch {}
  }
  return [];
}

export function saveListsIndex(index: ListSummary[]): void {
  ensureListsDir();
  fs.writeFileSync(LISTS_INDEX, JSON.stringify(index, null, 2), "utf-8");
}

export function loadList(listId: string): List | null {
  const file = listPath(listId);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      raw.fields = raw.fields ?? [];
      raw.items = (raw.items ?? []).map((it: ListItem) => ({
        ...it,
        values: it.values ?? {},
        linked_todos: it.linked_todos ?? [],
        archived: it.archived ?? false,
        created_at: it.created_at || "",
        updated_at: it.updated_at || "",
      }));
      return raw;
    } catch {}
  }
  return null;
}

export function saveList(list: List): void {
  ensureListsDir();
  fs.writeFileSync(listPath(list.id), JSON.stringify(list, null, 2), "utf-8");
}

export function deleteListFile(listId: string): void {
  try {
    fs.unlinkSync(listPath(listId));
  } catch {}
}

function toSummary(list: List): ListSummary {
  return { id: list.id, name: list.name, updated_at: list.updated_at };
}

export function upsertListIndex(list: List): void {
  const index = loadListsIndex();
  const i = index.findIndex((s) => s.id === list.id);
  if (i >= 0) {
    index[i] = toSummary(list);
  } else {
    index.push(toSummary(list));
  }
  index.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  saveListsIndex(index);
}

export function removeListIndex(listId: string): void {
  const index = loadListsIndex().filter((s) => s.id !== listId);
  saveListsIndex(index);
}

// ── CRUD ──

export function listLists(): ListSummary[] {
  return loadListsIndex();
}

export function getList(listId: string): List {
  const list = loadList(listId);
  if (!list) throw new Error(`list ${listId} not found`);
  return list;
}

export function createList(name: string, fields: ListField[] = []): List {
  const now = new Date().toISOString();
  const list: List = {
    id: randomUUID(),
    name,
    fields,
    items: [],
    created_at: now,
    updated_at: now,
  };
  saveList(list);
  upsertListIndex(list);
  return list;
}

export function updateListMeta(listId: string, name: string, fields: ListField[]): List {
  const list = getList(listId);
  const kept = new Set(fields.map((f) => f.key));
  for (const item of list.items) {
    for (const key of Object.keys(item.values)) {
      if (!kept.has(key)) delete item.values[key];
    }
  }
  list.name = name;
  list.fields = fields;
  list.updated_at = new Date().toISOString();
  saveList(list);
  upsertListIndex(list);
  return list;
}

export function deleteList(listId: string): void {
  deleteListFile(listId);
  removeListIndex(listId);
}

export function addListItem(listId: string, values: Record<string, unknown>): List {
  const list = getList(listId);
  const now = new Date().toISOString();
  list.items.push({
    id: randomUUID(),
    values: values ?? {},
    linked_todos: [],
    archived: false,
    created_at: now,
    updated_at: now,
  });
  list.updated_at = now;
  saveList(list);
  upsertListIndex(list);
  return list;
}

export function updateListItem(listId: string, item: ListItem): List {
  const list = getList(listId);
  const existing = list.items.find((i) => i.id === item.id);
  if (existing) {
    existing.values = item.values;
    existing.archived = item.archived ?? false;
    existing.updated_at = new Date().toISOString();
  }
  list.updated_at = new Date().toISOString();
  saveList(list);
  upsertListIndex(list);
  return list;
}

export function deleteListItem(listId: string, itemId: string): List {
  const list = getList(listId);
  list.items = list.items.filter((i) => i.id !== itemId);
  list.updated_at = new Date().toISOString();
  saveList(list);
  upsertListIndex(list);
  return list;
}
