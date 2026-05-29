import { useMemo } from "preact/hooks";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { mentionsToHtml, navigateFromMention } from "./mentions";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const html = useMemo(() => {
    const raw = marked.parse(mentionsToHtml(content), { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [content]);

  return (
    <div
      class="markdown-content"
      onClick={(e) => navigateFromMention(e.target)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
