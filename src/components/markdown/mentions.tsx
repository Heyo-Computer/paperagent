import type { ComponentChildren } from "preact";
import { activeTab, pendingListSelection, pendingBookSelection } from "../../state/store";

// Matches the agent-readable mention tokens:
//   todo:     @[Title](id:<id>|date:<date>)
//   artifact: @[Name](artifact:<relative/path>)
//   list:     @[Name](list:<listId>) or @[Name](list:<listId>/<itemId>)
//   book:     @[Name](book:<bookId>) or @[Name](book:<bookId>/<pageId>)
// Group 1 = label, 2 = todo id, 3 = todo date, 4 = artifact relative path,
// 5 = list id, 6 = list item id (optional), 7 = book id, 8 = book page id (optional).
// Exactly one kind is present per match.
export const MENTION_RE =
  /@\[([^\]]+)\]\((?:id:([^|)]+)\|date:([^)]+)|artifact:([^)]+)|list:([^/)]+)(?:\/([^)]+))?|book:([^/)]+)(?:\/([^)]+))?)\)/g;

// Navigate to the list/book target of a clicked mention chip. Returns true if it
// handled a list/book chip (todo/artifact chips are inert). `el` is the click target.
export function navigateFromMention(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  const chip = el.closest<HTMLElement>(".mention");
  if (!chip) return false;
  const listId = chip.getAttribute("data-list-id");
  if (listId) {
    pendingListSelection.value = { listId, itemId: chip.getAttribute("data-item-id") || undefined };
    activeTab.value = "lists";
    return true;
  }
  const bookId = chip.getAttribute("data-book-id");
  if (bookId) {
    pendingBookSelection.value = { bookId, pageId: chip.getAttribute("data-page-id") || undefined };
    activeTab.value = "books";
    return true;
  }
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Replace mention tokens with inline span HTML. Used before markdown parsing so
// the agent's @[Label](…) echoes render as styled chips, not broken links.
export function mentionsToHtml(content: string): string {
  return content.replace(MENTION_RE, (
    _m,
    label: string,
    id: string,
    date: string,
    artifactPath: string,
    listId: string,
    itemId: string,
    bookId: string,
    pageId: string,
  ) => {
    if (artifactPath !== undefined) {
      return `<span class="mention mention-artifact" data-artifact-path="${escapeHtml(artifactPath)}">@${escapeHtml(label)}</span>`;
    }
    if (listId !== undefined) {
      const itemAttr = itemId !== undefined ? ` data-item-id="${escapeHtml(itemId)}"` : "";
      return `<span class="mention mention-list" data-list-id="${escapeHtml(listId)}"${itemAttr}>@${escapeHtml(label)}</span>`;
    }
    if (bookId !== undefined) {
      const pageAttr = pageId !== undefined ? ` data-page-id="${escapeHtml(pageId)}"` : "";
      return `<span class="mention mention-book" data-book-id="${escapeHtml(bookId)}"${pageAttr}>@${escapeHtml(label)}</span>`;
    }
    return `<span class="mention" data-todo-id="${escapeHtml(id)}" data-todo-date="${escapeHtml(date)}">@${escapeHtml(label)}</span>`;
  });
}

// Render plain text with mention tokens turned into styled spans (for user bubbles,
// which are not markdown-rendered).
export function MentionText({ content }: { content: string }): ComponentChildren {
  const parts: ComponentChildren[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(MENTION_RE.source, "g");
  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    const [, label, id, date, artifactPath, listId, itemId, bookId, pageId] = match;
    if (artifactPath !== undefined) {
      parts.push(
        <span class="mention mention-artifact" data-artifact-path={artifactPath}>
          @{label}
        </span>
      );
    } else if (listId !== undefined) {
      parts.push(
        <span class="mention mention-list" data-list-id={listId} data-item-id={itemId}>
          @{label}
        </span>
      );
    } else if (bookId !== undefined) {
      parts.push(
        <span class="mention mention-book" data-book-id={bookId} data-page-id={pageId}>
          @{label}
        </span>
      );
    } else {
      parts.push(
        <span class="mention" data-todo-id={id} data-todo-date={date}>
          @{label}
        </span>
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }
  return <>{parts}</>;
}
