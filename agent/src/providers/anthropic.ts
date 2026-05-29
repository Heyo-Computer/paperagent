import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatProvider,
  ChatTurn,
  ProviderMessage,
  ToolResult,
  ToolSchema,
} from "./types.js";

const PROVIDER_NAME = "anthropic";

const serverTools: Anthropic.Messages.WebSearchTool20250305[] = [
  { type: "web_search_20250305", name: "web_search" },
];

function toAnthropicTools(tools: ToolSchema[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: t.parameters.properties,
      required: t.parameters.required,
    },
  }));
}

export class AnthropicProvider implements ChatProvider {
  readonly name = PROVIDER_NAME;
  readonly model: string;
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();
    this.model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
  }

  async chat(
    system: string,
    history: ProviderMessage[],
    tools: ToolSchema[],
  ): Promise<ChatTurn> {
    const messages = history.map((m) => m.payload as Anthropic.MessageParam);
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      tools: [...toAnthropicTools(tools), ...serverTools] as Anthropic.Tool[],
      messages,
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));

    return {
      text,
      toolCalls,
      rawAssistant: { __provider: PROVIDER_NAME, payload: { role: "assistant", content: response.content } },
    };
  }

  buildToolResultMessage(results: ToolResult[]): ProviderMessage {
    const blocks: Anthropic.ToolResultBlockParam[] = results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolCallId,
      content: r.content,
    }));
    return { __provider: PROVIDER_NAME, payload: { role: "user", content: blocks } };
  }
}

export function wrapUserMessage(text: string): ProviderMessage {
  return { __provider: PROVIDER_NAME, payload: { role: "user", content: text } };
}
