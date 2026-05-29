import { useEffect, useState } from "preact/hooks";
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
import type { List, ListField, ListItem, FieldKind } from "../../types";

const FIELD_KINDS: FieldKind[] = ["text", "number", "date", "bool", "select"];

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

  // new-row draft (keyed by field key)
  const [newRow, setNewRow] = useState<Record<string, unknown>>({});

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
  }

  function startEditSchema() {
    if (!current) return;
    setEditingSchema(true);
    setFormName(current.name);
    setDrafts(fieldsToDrafts(current.fields));
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
    if (!name) return;
    const fields = draftToFields(drafts);
    const list = await createList(name, fields);
    setCreating(false);
    await reloadSummaries();
    setSelectedId(list.id);
    setCurrent(list);
    setNewRow({});
  }

  async function submitSchema() {
    if (!current) return;
    const name = formName.trim() || current.name;
    const fields = draftToFields(drafts);
    const list = await updateListMeta(current.id, name, fields);
    setEditingSchema(false);
    setCurrent(list);
    await reloadSummaries();
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
      {/* Left rail */}
      <div class="lists-rail">
        <div class="lists-rail-header">
          <span>Lists</span>
          <button class="btn btn-sm btn-primary" onClick={startCreate}>+ New</button>
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
            <div class="lists-form-actions">
              <button class="btn btn-secondary" onClick={() => { setCreating(false); setEditingSchema(false); }}>Cancel</button>
              <button class="btn btn-primary" onClick={creating ? submitCreate : submitSchema}>
                {creating ? "Create" : "Save"}
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
            {current.fields.length === 0 ? (
              <div class="accordion-empty">No fields — edit the schema to add some.</div>
            ) : (
              <div class="lists-table-wrap">
                <table class="lists-table">
                  <thead>
                    <tr>
                      {current.fields.map((f) => (
                        <th key={f.key}>{f.label}</th>
                      ))}
                      <th>Linked todos</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.items.map((item) => (
                      <tr key={item.id} class={highlightItemId === item.id ? "lists-row-highlight" : ""}>
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
                          <button class="btn btn-sm btn-ghost" onClick={() => handleDeleteRow(item.id)} title="Delete row">✕</button>
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
