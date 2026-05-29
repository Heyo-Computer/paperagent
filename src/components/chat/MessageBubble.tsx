import { MarkdownRenderer } from "../markdown/MarkdownRenderer";
import { MentionText, navigateFromMention } from "../markdown/mentions";
import type { AgentMessage } from "../../types";

interface MessageBubbleProps {
  message: AgentMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div class={`chat-bubble ${message.role}`}>
      {message.role === "assistant" ? (
        <MarkdownRenderer content={message.content} />
      ) : (
        <span onClick={(e) => navigateFromMention(e.target)}><MentionText content={message.content} /></span>
      )}
      <div class="chat-bubble-time">{time}</div>
    </div>
  );
}
