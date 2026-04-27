/**
 * Anthropic provider adapter.
 *
 * Handles Claude models via the official @anthropic-ai/sdk.
 * Normalizes Anthropic's message format, streaming events,
 * and tool calling to the unified llm-harness contract.
 */

import type {
  LLMProvider,
  ProviderConfig,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ToolCall,
  Usage,
  ToolDefinition,
} from "../types.js";

type AnthropicModule = typeof import("@anthropic-ai/sdk");
type Anthropic = InstanceType<AnthropicModule["default"]>;

let AnthropicClass: AnthropicModule["default"] | null = null;

async function getAnthropic(): Promise<AnthropicModule["default"]> {
  if (AnthropicClass) return AnthropicClass;
  try {
    const mod = await import("@anthropic-ai/sdk");
    AnthropicClass = mod.default;
    return AnthropicClass;
  } catch {
    throw new Error(
      'Anthropic provider requires the "@anthropic-ai/sdk" package. Install it: npm install @anthropic-ai/sdk',
    );
  }
}

/** Convert our tool definitions to Anthropic format. */
function toAnthropicTools(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as unknown as Record<string, unknown>,
  }));
}

/** Convert our messages to Anthropic format (system is separate). */
function toAnthropicMessages(messages: CompletionRequest["messages"]) {
  const result: Record<string, unknown>[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue; // handled separately

    if (msg.role === "tool") {
      // Anthropic expects tool results as user messages with tool_result content blocks
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          },
        ],
      });
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const blocks: Record<string, unknown>[] = [];
      for (const b of msg.content) {
        if (b.type === "text") {
          blocks.push({ type: "text", text: (b as { text: string }).text });
        } else if (b.type === "tool_use") {
          const tu = b as { id: string; name: string; arguments: Record<string, unknown> };
          blocks.push({
            type: "tool_use",
            id: tu.id,
            name: tu.name,
            input: tu.arguments,
          });
        }
      }
      result.push({ role: "assistant", content: blocks });
    } else {
      result.push({
        role: msg.role,
        content: typeof msg.content === "string"
          ? msg.content
          : msg.content.map((b) => ({ type: "text", text: (b as { text: string }).text })),
      });
    }
  }

  return result;
}

/** Extract system prompt from messages + explicit system param. */
function extractSystem(
  messages: CompletionRequest["messages"],
  system?: string,
): string | undefined {
  const parts: string[] = [];
  if (system) parts.push(system);

  for (const msg of messages) {
    if (msg.role === "system") {
      parts.push(typeof msg.content === "string" ? msg.content : "");
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// Anthropic has no native JSON-mode flag (unlike OpenAI's response_format).
// The official guidance is to instruct the model in the system prompt and
// rely on Claude's strong instruction-following. Appended at the end so it
// takes precedence over any conflicting earlier guidance.
const JSON_MODE_INSTRUCTION =
  "You must respond with a single valid JSON object and nothing else. " +
  "Do not include any prose, explanation, or commentary before or after the JSON. " +
  "Do not wrap the JSON in markdown code fences.";

function withJsonModeInstruction(
  system: string | undefined,
  responseFormat: CompletionRequest["responseFormat"],
): string | undefined {
  if (responseFormat !== "json_object") return system;
  return system ? `${system}\n\n${JSON_MODE_INSTRUCTION}` : JSON_MODE_INSTRUCTION;
}

export function createAnthropicProvider(
  config: ProviderConfig,
): LLMProvider {
  let client: Anthropic | null = null;

  async function getClient(): Promise<Anthropic> {
    if (client) return client;
    const Cls = await getAnthropic();
    client = new Cls({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    return client;
  }

  return {
    id: "anthropic",

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const c = await getClient();
      const model = request.model;
      const system = withJsonModeInstruction(
        extractSystem(request.messages, request.system),
        request.responseFormat,
      );

      const response = await (c.messages.create as Function)({
        model,
        messages: toAnthropicMessages(request.messages),
        ...(system ? { system } : {}),
        tools: toAnthropicTools(request.tools),
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature,
        top_p: request.topP,
        stop_sequences: request.stop,
      });

      let text = "";
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }

      const usage: Usage = {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        totalTokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      };

      return {
        text,
        toolCalls,
        done: toolCalls.length === 0,
        usage,
        providerId: "anthropic",
        model,
        finishReason: response.stop_reason,
      };
    },

    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const c = await getClient();
      const model = request.model;
      const system = withJsonModeInstruction(
        extractSystem(request.messages, request.system),
        request.responseFormat,
      );

      const stream = (c.messages.stream as Function)({
        model,
        messages: toAnthropicMessages(request.messages),
        ...(system ? { system } : {}),
        tools: toAnthropicTools(request.tools),
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature,
        top_p: request.topP,
        stop_sequences: request.stop,
      });

      let text = "";
      const toolCalls: ToolCall[] = [];
      let currentToolIndex = -1;
      let currentToolId = "";
      let currentToolName = "";
      let currentToolArgs = "";
      let usage: Usage | undefined;
      let finishReason: string | undefined;

      try {
        for await (const event of stream) {
          switch (event.type) {
            case "content_block_start": {
              if (event.content_block.type === "tool_use") {
                currentToolIndex++;
                currentToolId = event.content_block.id;
                currentToolName = event.content_block.name;
                currentToolArgs = "";

                yield {
                  type: "tool_call_delta",
                  index: currentToolIndex,
                  id: currentToolId,
                  name: currentToolName,
                };
              }
              break;
            }

            case "content_block_delta": {
              if (event.delta.type === "text_delta") {
                text += event.delta.text;
                yield { type: "text_delta", text: event.delta.text };
              } else if (event.delta.type === "input_json_delta") {
                currentToolArgs += event.delta.partial_json;
                yield {
                  type: "tool_call_delta",
                  index: currentToolIndex,
                  arguments: event.delta.partial_json,
                };
              }
              break;
            }

            case "content_block_stop": {
              if (currentToolName) {
                toolCalls.push({
                  id: currentToolId,
                  name: currentToolName,
                  arguments: currentToolArgs,
                });
                currentToolName = "";
              }
              break;
            }

            case "message_delta": {
              finishReason = event.delta?.stop_reason;
              if (event.usage) {
                usage = {
                  inputTokens: usage?.inputTokens || 0,
                  outputTokens: event.usage.output_tokens || 0,
                  totalTokens: (usage?.inputTokens || 0) + (event.usage.output_tokens || 0),
                };
              }
              break;
            }

            case "message_start": {
              if (event.message?.usage) {
                usage = {
                  inputTokens: event.message.usage.input_tokens || 0,
                  outputTokens: 0,
                  totalTokens: event.message.usage.input_tokens || 0,
                };
              }
              break;
            }
          }
        }
      } catch (error) {
        yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
        return;
      }

      yield {
        type: "complete",
        response: {
          text,
          toolCalls,
          done: toolCalls.length === 0,
          usage,
          providerId: "anthropic",
          model,
          finishReason,
        },
      };
    },
  };
}
