/**
 * Provider-agnostic chat interface. Each backing LLM (Anthropic, OpenRouter)
 * implements `chat`, taking a running conversation and tool definitions, and
 * returning the assistant turn — text plus any tool calls the model wants to
 * make. The Agent class drives the tool loop.
 */

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, JSONSchemaProperty>;
    required: string[];
  };
}

export interface ChatToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatTurn {
  text: string;
  toolCalls: ChatToolCall[];
  /** Raw assistant message in the provider's native format, for replay in the conversation history. */
  rawAssistant: unknown;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  chat(
    system: string,
    history: ProviderMessage[],
    tools: ToolSchema[],
  ): Promise<ChatTurn>;
  /** Build a "user" message containing tool results (format depends on provider). */
  buildToolResultMessage(results: ToolResult[]): ProviderMessage;
}

/** Opaque per-provider message; only the provider that produced it can interpret. */
export type ProviderMessage = { __provider: string; payload: unknown };
