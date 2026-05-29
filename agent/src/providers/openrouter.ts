import OpenAI from "openai";
import type {
  ChatProvider,
  ChatTurn,
  ProviderMessage,
  ToolResult,
  ToolSchema,
} from "./types.js";

const PROVIDER_NAME = "openrouter";

function toOpenAITools(tools: ToolSchema[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export class OpenRouterProvider implements ChatProvider {
  readonly name = PROVIDER_NAME;
  readonly model: string;
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENROUTER_API_KEY ?? "";
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_REFERER ?? "https://github.com/sarocu/todo",
        "X-Title": "todo-agent",
      },
    });
    this.model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4-6";
  }

  async chat(
    system: string,
    history: ProviderMessage[],
    tools: ToolSchema[],
  ): Promise<ChatTurn> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
    ];
    for (const m of history) {
      if (Array.isArray(m.payload)) {
        messages.push(...(m.payload as OpenAI.Chat.Completions.ChatCompletionMessageParam[]));
      } else {
        messages.push(m.payload as OpenAI.Chat.Completions.ChatCompletionMessageParam);
      }
    }

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages,
      tools: toOpenAITools(tools),
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    const text = assistantMsg.content ?? "";
    const toolCalls = (assistantMsg.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: safeParseJson(tc.function.arguments),
    }));

    return {
      text,
      toolCalls,
      rawAssistant: { __provider: PROVIDER_NAME, payload: assistantMsg },
    };
  }

  buildToolResultMessage(results: ToolResult[]): ProviderMessage {
    // OpenAI tool results are one message per call, not one batch.
    // Wrap them in an array under a single ProviderMessage so the Agent can
    // unpack on history append.
    const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = results.map((r) => ({
      role: "tool" as const,
      tool_call_id: r.toolCallId,
      content: r.content,
    }));
    return { __provider: PROVIDER_NAME, payload: msgs };
  }
}

export function wrapUserMessage(text: string): ProviderMessage {
  const payload: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
    role: "user",
    content: text,
  };
  return { __provider: PROVIDER_NAME, payload };
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
