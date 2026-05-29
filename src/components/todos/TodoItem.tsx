import { expandedTodoId, navigateToLink } from "../../state/store";
import { TodoSpec } from "./TodoSpec";
import type { TodoItem as TodoItemType } from "../../types";

interface TodoItemProps {
  todo: TodoItemType;
  date: string;
  onToggle: () => void;
  onDelete: () => void;
  onUpdate: (todo: TodoItemType) => void;
}

export function TodoItem({ todo, date, onToggle, onDelete, onUpdate }: TodoItemProps) {
  const isExpanded = expandedTodoId.value === todo.id;

  function toggleExpand() {
    expandedTodoId.value = isExpanded ? null : todo.id;
  }

  return (
    <div class="todo-item">
      <div class="todo-item-row">
        <button
          class={`todo-checkbox ${todo.completed ? "checked" : ""}`}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        />
        <span class={`todo-title ${todo.completed ? "completed" : ""}`}>
          {todo.title}
        </span>
        <button class="todo-expand-btn" onClick={(e) => { e.stopPropagation(); toggleExpand(); }}>
          {isExpanded ? "Collapse" : "Spec"}
        </button>
        <button class="todo-expand-btn todo-delete-btn" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6" /><path d="M14 11v6" />
          </svg>
        </button>
      </div>
      {!isExpanded && todo.links && todo.links.length > 0 && (
        <div class="todo-links">
          {todo.links.map((link) => (
            <button
              key={`${link.kind}:${link.target_id}/${link.sub_id}`}
              class={`mention mention-${link.kind} todo-link-chip`}
              onClick={(e) => { e.stopPropagation(); navigateToLink(link); }}
              title={`Open ${link.kind}`}
            >
              {link.label || link.sub_id}
            </button>
          ))}
        </div>
      )}
      {isExpanded && (
        <TodoSpec todo={todo} date={date} onUpdate={onUpdate} />
      )}
    </div>
  );
}
