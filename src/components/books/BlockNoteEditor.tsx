import { useEffect } from "preact/hooks";
import { forwardRef, useImperativeHandle } from "preact/compat";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { currentTheme } from "../../theme/ThemeProvider";

export interface BlockNoteHandle {
  /** Serialise the current document to a BlockNote-JSON string for storage. */
  getContent: () => string;
}

/**
 * Decide how to seed the editor from a stored page string. Pages are stored as
 * BlockNote block JSON, but older pages (and agent-seeded content) are markdown.
 * Returns parsed blocks for the JSON case, or null to take the markdown path.
 */
function parseStoredBlocks(content: string): unknown[] | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const blocks = JSON.parse(trimmed);
    if (Array.isArray(blocks) && blocks.length > 0) return blocks;
  } catch {
    /* not JSON — fall through to markdown */
  }
  return null;
}

interface Props {
  /** Stored page content: BlockNote JSON or legacy markdown. */
  content: string;
  /** Fired on any document edit (used by the parent to track a dirty flag). */
  onChange?: () => void;
}

/**
 * Uncontrolled BlockNote editor mounted inside Preact via preact/compat. The
 * parent remounts it (key={pageId}) on page switch, so this only needs to seed
 * its initial content once. Save is driven imperatively via the ref.
 */
export const BlockNoteEditor = forwardRef<BlockNoteHandle, Props>(
  ({ content, onChange }, ref) => {
    const initialBlocks = parseStoredBlocks(content);
    const editor = useCreateBlockNote(
      initialBlocks ? { initialContent: initialBlocks as never } : {},
    );

    // Legacy markdown pages: parse async and load after mount (one-time
    // migration — they get saved back as JSON on the next save).
    useEffect(() => {
      if (initialBlocks) return;
      const md = content.trim();
      if (!md) return;
      let cancelled = false;
      (async () => {
        const blocks = await editor.tryParseMarkdownToBlocks(md);
        if (!cancelled && blocks.length) {
          editor.replaceBlocks(editor.document, blocks);
        }
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(
      ref,
      () => ({ getContent: () => JSON.stringify(editor.document) }),
      [editor],
    );

    const themeMode = currentTheme.value.name === "light" ? "light" : "dark";

    return (
      <BlockNoteView
        editor={editor}
        theme={themeMode}
        onChange={onChange}
        className="books-blocknote"
      />
    );
  },
);
