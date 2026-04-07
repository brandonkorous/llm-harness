/**
 * OpenAI provider adapter.
 *
 * Handles OpenAI and any OpenAI-compatible API (Ollama, Together, Groq,
 * Azure, LM Studio, vLLM, etc.) via the official openai SDK.
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

type OpenAIModule = typeof import("openai");
type OpenAI = InstanceType<OpenAIModule["default"]>;

let OpenAIClass: OpenAIModule["default"] | null = null;

async function getOpenAI(): Promise<OpenAIModule["default"]> {
  if (OpenAIClass) return OpenAIClass;
  try {
    const mod = await import("openai");
    OpenAIClass = mod.default;
    return OpenAIClass;
  } catch {
    throw new Error(
      'OpenAI provider requires the "openai" package. Install it: npm install openai',
    );
  }
}

/** Convert our tool definitions to OpenAI format. */
function toOpenAITools(
  tools?: ToolDefinition[],
): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Convert our messages to OpenAI format. */
function toOpenAIMessages(
  messages: CompletionRequest["messages"],
  system?: string,
) {
  const result: Record<string, unknown>[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (msg.role === "tool") {
      result.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      // Handle assistant messages with tool calls
      const textParts = msg.content.filter((b) => b.type === "text");
      const toolParts = msg.content.filter((b) => b.type === "tool_use");
      result.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.map((b) => (b as { text: string }).text).join("") : null,
        ...(toolParts.length > 0
          ? {
              tool_calls: toolParts.map((b) => {
                const tu = b as { id: string; name: string; arguments: Record<string, unknown> };
                return {
                  id: tu.id,
                  type: "function",
                  function: { name: tu.name, arguments: JSON.stringify(tu.arguments) },
                };
              }),
            }
          : {}),
      });
    } else {
      result.push({
        role: msg.role,
        content: typeof msg.content === "string"
          ? msg.content
          : msg.content.map((b) => (b as { text: string }).text).join(""),
      });
    }
  }

  return result;
}

export function createOpenAIProvider(
  config: ProviderConfig,
  providerId = "openai",
): LLMProvider {
  let client: OpenAI | null = null;

  async function getClient(): Promise<OpenAI> {
    if (client) return client;
    const Cls = await getOpenAI();
    client = new Cls({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      organization: config.organization,
    });
    return client;
  }

  return {
    id: providerId,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const c = await getClient();
      const model = request.model;

      const response = await (c.chat.completions.create as Function)({
        model,
        messages: toOpenAIMessages(request.messages, request.system),
        tools: toOpenAITools(request.tools),
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
        stop: request.stop,
        ...(request.metadata ? { metadata: request.metadata } : {}),
      });

      const choice = response.choices[0];
      const toolCalls: ToolCall[] = (choice.message.tool_calls || []).map(
        (tc: any) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }),
      );

      const usage: Usage | undefined = response.usage
        ? {
            inputTokens: response.usage.prompt_tokens || 0,
            outputTokens: response.usage.completion_tokens || 0,
            totalTokens: response.usage.total_tokens || 0,
          }
        : undefined;

      return {
        text: choice.message.content || "",
        toolCalls,
        done: toolCalls.length === 0,
        usage,
        providerId,
        model,
        finishReason: choice.finish_reason,
      };
    },

    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const c = await getClient();
      const model = request.model;

      const response = await (c.chat.completions.create as Function)({
        model,
        messages: toOpenAIMessages(request.messages, request.system),
        tools: toOpenAITools(request.tools),
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
        stop: request.stop,
        stream: true,
        stream_options: { include_usage: true },
        ...(request.metadata ? { metadata: request.metadata } : {}),
      });

      let text = "";
      const toolCallBuffers: Record<number, { id: string; name: string; args: string }> = {};
      let usage: Usage | undefined;
      let finishReason: string | undefined;

      try {
        for await (const chunk of response) {
          const delta = chunk.choices?.[0]?.delta;
          finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;

          // Usage from the final chunk
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens || 0,
              outputTokens: chunk.usage.completion_tokens || 0,
              totalTokens: chunk.usage.total_tokens || 0,
            };
          }

          if (!delta) continue;

          // Text content
          if (delta.content) {
            text += delta.content;
            yield { type: "text_delta", text: delta.content };
          }

          // Tool calls (streamed incrementally)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (!toolCallBuffers[tc.index]) {
                toolCallBuffers[tc.index] = { id: "", name: "", args: "" };
              }
              const buf = toolCallBuffers[tc.index];
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name = tc.function.name;
              if (tc.function?.arguments) buf.args += tc.function.arguments;

              yield {
                type: "tool_call_delta",
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                arguments: tc.function?.arguments,
              };
            }
          }
        }
      } catch (error) {
        yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
        return;
      }

      // Build final tool calls
      const toolCalls: ToolCall[] = Object.values(toolCallBuffers).map((buf) => ({
        id: buf.id,
        name: buf.name,
        arguments: buf.args,
      }));

      yield {
        type: "complete",
        response: {
          text,
          toolCalls,
          done: toolCalls.length === 0,
          usage,
          providerId,
          model,
          finishReason,
        },
      };
    },
  };
}
