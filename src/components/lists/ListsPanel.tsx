import { useEffect, useMemo, useState } from "preact/hooks";
import {
  listLists,
  loadList,
  createList,
  updateListMeta,
  deleteList,
  addListItem,
  updateListItem,
  deleteListItem,
} from "../../api/commands";
import { allLists, pendingListSelection, navigateToTodo } from "../../state/store";
import { getPref, setPref } from "../../state/uiPrefs";
import type { List, ListField, ListItem, FieldKind } from "../../types";

const FIELD_KINDS: FieldKind[] = ["text", "number", "date", "bool", "select"];

const DEFAULT_COL_WIDTH = 150;
const MIN_COL_WIDTH = 60;
type SortDir = "asc" | "desc";

/** Compare two cell values for a given field kind (used by column sorting). */
function compareValues(a: unknown, b: unknown, kind: FieldKind): number {
  const emptyA = a === undefined || a === null || a === "";
  const emptyB = b === undefined || b === null || b === "";
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1; // empties sort last
  if (emptyB) return -1;
  if (kind === "number") return Number(a) - Number(b);
  if (kind === "bool") return Number(Boolean(a)) - Number(Boolean(b));
  // date + text + select: lexical (ISO dates sort correctly as strings)
  return String(a).localeCompare(String(b));
}

function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "field"
  );
}

/** A draft field row in the schema editor. */
interface DraftField {
  label: string;
  kind: FieldKind;
  optionsText: string;
}

function draftToFields(drafts: DraftField[]): ListField[] {
  const seen = new Set<string>();
  return drafts
    .filter((d) => d.label.trim().length > 0)
    .map((d) => {
      let key = slugify(d.label);
      while (seen.has(key)) key = `${key}_`;
      seen.add(key);
      const field: ListField = { key, label: d.label.trim(), kind: d.kind };
      if (d.kind === "select") {
        field.options = d.optionsText
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      return field;
    });
}

function fieldsToDrafts(fields: ListField[]): DraftField[] {
  return fields.map((f) => ({
    label: f.label,
    kind: f.kind,
    optionsText: (f.options ?? []).join(", "),
  }));
}

export function ListsPanel() {
  const [summaries, setSummaries] = useState(allLists.value);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [current, setCurrent] = useState<List | null>(null);
  const [highlightItemId, setHighlightItemId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingSchema, setEditingSchema] = useState(false);

  // create / schema-edit form state
  const [formName, setFormName] = useState("");
  const [drafts, setDrafts] = useState<DraftField[]>([{ label: "", kind: "text", optionsText: "" }]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // new-row draft (keyed by field key)
  const [newRow, setNewRow] = useState<Record<string, unknown>>({});

  // view state — archive filter, sorting, sidebar collapse, column widths
  const [showArchived, setShowArchived] = useState(false);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [railCollapsed, setRailCollapsed] = useState(() =>
    getPref("lists.railCollapsed", false),
  );
  const [colWidths, setColWidths] = useState<Record<string, number>>({});

  function toggleRail() {
    setRailCollapsed((v) => {
      const next = !v;
      setPref("lists.railCollapsed", next);
      return next;
    });
  }

  async function reloadSummaries() {
    try {
      const s = await listLists();
      setSummaries(s);
      allLists.value = s;
    } catch {
      setSummaries([]);
    }
  }

  useEffect(() => {
    reloadSummaries();
  }, []);

  // Honour a cross-tab navigation request (linked-todo / mention chip click).
  useEffect(() => {
    const sel = pendingListSelection.value;
    if (!sel) return;
    pendingListSelection.value = null;
    setHighlightItemId(sel.itemId ?? null);
    selectList(sel.listId);
  }, [pendingListSelection.value]);

  async function selectList(id: string) {
    setCreating(false);
    setEditingSchema(false);
    setSelectedId(id);
    try {
      const l = await loadList(id);
      setCurrent(l);
      setNewRow({});
      setColWidths(getPref(`lists.colWidths.${id}`, {} as Record<string, number>));
    } catch {
      setCurrent(null);
    }
  }

  function startCreate() {
    setCreating(true);
    setEditingSchema(false);
    setSelectedId(null);
    setCurrent(null);
    setFormName("");
    setDrafts([{ label: "", kind: "text", optionsText: "" }]);
    setFormError(null);
  }

  function startEditSchema() {
    if (!current) return;
    setEditingSchema(true);
    setFormName(current.name);
    setDrafts(fieldsToDrafts(current.fields));
    setFormError(null);
  }

  function addDraftRow() {
    setDrafts([...drafts, { label: "", kind: "text", optionsText: "" }]);
  }

  function updateDraft(i: number, patch: Partial<DraftField>) {
    setDrafts(drafts.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  function removeDraft(i: number) {
    setDrafts(drafts.filter((_, idx) => idx !== i));
  }

  async function submitCreate() {
    const name = formName.trim();
    if (!name) {
      setFormError("Please enter a list name.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const fields = draftToFields(drafts);
      const list = await createList(name, fields);
      setCreating(false);
      await reloadSummaries();
      setSelectedId(list.id);
      setCurrent(list);
      setNewRow({});
    } catch (e) {
      setFormError(`Couldn't create the list: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function submitSchema() {
    if (!current) return;
    setSaving(true);
    setFormError(null);
    try {
      const name = formName.trim() || current.name;
      const fields = draftToFields(drafts);
      const list = await updateListMeta(current.id, name, fields);
      setEditingSchema(false);
      setCurrent(list);
      await reloadSummaries();
    } catch (e) {
      setFormError(`Couldn't save the schema: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteList() {
    if (!current) return;
    if (!confirm(`Delete list "${current.name}"? This cannot be undone.`)) return;
    await deleteList(current.id);
    setCurrent(null);
    setSelectedId(null);
    await reloadSummaries();
  }

  async function handleAddRow() {
    if (!current) return;
    const list = await addListItem(current.id, newRow);
    setCurrent(list);
    setNewRow({});
  }

  async function handleCellChange(item: ListItem, key: string, value: unknown) {
    if (!current) return;
    const updated: ListItem = { ...item, values: { ...item.values, [key]: value } };
    // optimistic
    setCurrent({ ...current, items: current.items.map((i) => (i.id === item.id ? updated : i)) });
    const list = await updateListItem(current.id, updated);
    setCurrent(list);
  }

  async function handleDeleteRow(itemId: string) {
    if (!current) return;
    const list = await deleteListItem(current.id, itemId);
    setCurrent(list);
  }

  async function handleArchive(item: ListItem) {
    if (!current) return;
    const updated: ListItem = { ...item, archived: !item.archived };
    // optimistic
    setCurrent({ ...current, items: current.items.map((i) => (i.id === item.id ? updated : i)) });
    const list = await updateListItem(current.id, updated);
    setCurrent(list);
  }

  /** Drag-resize a single column, mirroring the App.tsx resize pattern. */
  function startColResize(e: MouseEvent, key: string) {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = colWidths[key] ?? DEFAULT_COL_WIDTH;
    const startX = e.clientX;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const w = Math.max(MIN_COL_WIDTH, startWidth + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [key]: w }));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // persist on release (per list)
      if (current) {
        setColWidths((prev) => {
          setPref(`lists.colWidths.${current.id}`, prev);
          return prev;
        });
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Visible rows: hide archived by default, then sort a copy (never mutate items).
  const visibleItems = useMemo(() => {
    if (!current) return [] as ListItem[];
    const rows = current.items.filter((i) => showArchived || !i.archived);
    if (!sortKey) return rows;
    const field = current.fields.find((f) => f.key === sortKey);
    const sorted = [...rows].sort((a, b) => {
      let cmp: number;
      if (sortKey === "__created") cmp = a.created_at.localeCompare(b.created_at);
      else if (sortKey === "__updated") cmp = a.updated_at.localeCompare(b.updated_at);
      else cmp = compareValues(a.values[sortKey], b.values[sortKey], field?.kind ?? "text");
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [current, showArchived, sortKey, sortDir]);

  function renderCellInput(
    field: ListField,
    value: unknown,
    onChange: (v: unknown) => void,
  ) {
    switch (field.kind) {
      case "bool":
        return (
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        );
      case "number":
        return (
          <input
            class="settings-input list-cell-input"
            type="number"
            value={value === undefined || value === null ? "" : String(value)}
            onBlur={(e) => onChange(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
          />
        );
      case "date":
        return (
          <input
            class="settings-input list-cell-input"
            type="date"
            value={value ? String(value) : ""}
            onBlur={(e) => onChange(e.currentTarget.value)}
          />
        );
      case "select":
        return (
          <select
            class="settings-input list-cell-input"
            value={value ? String(value) : ""}
            onChange={(e) => onChange(e.currentTarget.value)}
          >
            <option value=""></option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        );
      default:
        return (
          <input
            class="settings-input list-cell-input"
            type="text"
            value={value ? String(value) : ""}
            onBlur={(e) => onChange(e.currentTarget.value)}
          />
        );
    }
  }

  const showForm = creating || editingSchema;

  return (
    <div class="lists-layout">
      {/* Left rail (collapsible) */}
      {railCollapsed ? (
        <button class="rail-expand-btn" onClick={toggleRail} title="Show lists">›</button>
      ) : (
        <div class="lists-rail">
          <div class="lists-rail-header">
            <span>Lists</span>
            <div class="lists-rail-header-actions">
              <button class="btn btn-sm btn-primary" onClick={startCreate}>+ New</button>
              <button class="btn btn-sm btn-ghost" onClick={toggleRail} title="Collapse sidebar">‹</button>
            </div>
          </div>
          <div class="lists-rail-items">
            {summaries.length === 0 ? (
              <div class="accordion-empty">No lists yet</div>
            ) : (
              summaries.map((s) => (
                <button
                  key={s.id}
                  class={`lists-rail-item ${selectedId === s.id ? "active" : ""}`}
                  onClick={() => selectList(s.id)}
                >
                  {s.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main */}
      <div class="lists-main">
        {showForm ? (
          <div class="lists-form">
            <h3>{creating ? "New list" : "Edit schema"}</h3>
            <input
              class="settings-input"
              type="text"
              placeholder="List name (e.g. Customers)"
              value={formName}
              onInput={(e) => setFormName(e.currentTarget.value)}
            />
            <div class="lists-fields-editor">
              <div class="lists-fields-label">Fields</div>
              {drafts.map((d, i) => (
                <div key={i} class="lists-field-row">
                  <input
                    class="settings-input"
                    type="text"
                    placeholder="Label"
                    value={d.label}
                    onInput={(e) => updateDraft(i, { label: e.currentTarget.value })}
                  />
                  <select
                    class="settings-input"
                    value={d.kind}
                    onChange={(e) => updateDraft(i, { kind: e.currentTarget.value as FieldKind })}
                  >
                    {FIELD_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  {d.kind === "select" && (
                    <input
                      class="settings-input"
                      type="text"
                      placeholder="Options (comma-separated)"
                      value={d.optionsText}
                      onInput={(e) => updateDraft(i, { optionsText: e.currentTarget.value })}
                    />
                  )}
                  <button class="btn btn-sm btn-danger" onClick={() => removeDraft(i)}>✕</button>
                </div>
              ))}
              <button class="btn btn-sm btn-secondary" onClick={addDraftRow}>+ Field</button>
            </div>
            {formError && <div class="lists-form-error">{formError}</div>}
            <div class="lists-form-actions">
              <button class="btn btn-secondary" disabled={saving} onClick={() => { setCreating(false); setEditingSchema(false); setFormError(null); }}>Cancel</button>
              <button class="btn btn-primary" disabled={saving} onClick={creating ? submitCreate : submitSchema}>
                {saving ? "Saving…" : creating ? "Create" : "Save"}
              </button>
            </div>
          </div>
        ) : current ? (
          <div class="lists-detail">
            <div class="lists-detail-header">
              <h3>{current.name}</h3>
              <div class="lists-detail-actions">
                <button class="btn btn-sm btn-secondary" onClick={startEditSchema}>Edit schema</button>
                <button class="btn btn-sm btn-danger" onClick={handleDeleteList}>Delete list</button>
              </div>
            </div>
            {current.fields.length > 0 && (
              <div class="lists-toolbar">
                <label class="lists-toolbar-check">
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(e) => setShowArchived(e.currentTarget.checked)}
                  />
                  Show archived
                </label>
                <span class="lists-toolbar-spacer" />
                <span class="lists-toolbar-label">Sort</span>
                <select
                  class="settings-input lists-toolbar-select"
                  value={sortKey ?? ""}
                  onChange={(e) => setSortKey(e.currentTarget.value || null)}
                >
                  <option value="">None</option>
                  {current.fields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                  <option value="__created">Created</option>
                  <option value="__updated">Updated</option>
                </select>
                <button
                  class="btn btn-sm btn-ghost"
                  disabled={!sortKey}
                  onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                  title="Toggle sort direction"
                >
                  {sortDir === "asc" ? "↑" : "↓"}
                </button>
              </div>
            )}
            {current.fields.length === 0 ? (
              <div class="accordion-empty">No fields — edit the schema to add some.</div>
            ) : (
              <div class="lists-table-wrap">
                <table class="lists-table lists-table-fixed">
                  <thead>
                    <tr>
                      {current.fields.map((f) => (
                        <th key={f.key} style={{ width: `${colWidths[f.key] ?? DEFAULT_COL_WIDTH}px` }}>
                          {f.label}
                          <span
                            class="lists-col-resize-handle"
                            onMouseDown={(e) => startColResize(e, f.key)}
                          />
                        </th>
                      ))}
                      <th style={{ width: `${colWidths.__linked ?? 160}px` }}>
                        Linked todos
                        <span
                          class="lists-col-resize-handle"
                          onMouseDown={(e) => startColResize(e, "__linked")}
                        />
                      </th>
                      <th style={{ width: "72px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((item) => (
                      <tr
                        key={item.id}
                        class={`${highlightItemId === item.id ? "lists-row-highlight" : ""} ${item.archived ? "lists-row-archived" : ""}`}
                      >
                        {current.fields.map((f) => (
                          <td key={f.key}>
                            {renderCellInput(f, item.values[f.key], (v) => handleCellChange(item, f.key, v))}
                          </td>
                        ))}
                        <td>
                          <div class="panel-linked-todos">
                            {item.linked_todos.map((ref) => (
                              <button
                                key={`${ref.date}:${ref.todo_id}`}
                                class="mention todo-link-chip"
                                onClick={() => navigateToTodo(ref)}
                                title="Open todo"
                              >
                                {ref.label || ref.todo_id}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div class="lists-row-actions">
                            <button
                              class="btn btn-sm btn-ghost"
                              onClick={() => handleArchive(item)}
                              title={item.archived ? "Unarchive" : "Archive"}
                            >
                              {item.archived ? "⊕" : "⊗"}
                            </button>
                            <button class="btn btn-sm btn-ghost" onClick={() => handleDeleteRow(item.id)} title="Delete row">✕</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {/* new row */}
                    <tr class="lists-new-row">
                      {current.fields.map((f) => (
                        <td key={f.key}>
                          {renderCellInput(f, newRow[f.key], (v) => setNewRow({ ...newRow, [f.key]: v }))}
                        </td>
                      ))}
                      <td></td>
                      <td>
                        <button class="btn btn-sm btn-primary" onClick={handleAddRow}>Add</button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : (
          <div class="accordion-empty">Select a list or create a new one.</div>
        )}
      </div>
    </div>
  );
}
