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
  DocumentContent,
  Message,
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

/** True if the request carries at least one `document` content block. */
function hasDocuments(messages: CompletionRequest["messages"]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "document") return true;
    }
  }
  return false;
}

/**
 * Models known to support the Responses API. File inputs (PDFs, etc.) are not
 * available on legacy Chat Completions, so we hard-fail with a clear message
 * instead of silently dropping the document.
 */
function supportsResponsesApi(model: string): boolean {
  const m = model.toLowerCase().replace(/^openai\//, "");
  return (
    m.startsWith("gpt-5") ||
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    /^o[1-9]/.test(m)
  );
}

/** Convert a document block to a Responses API `input_file` content part. */
function toOpenAIDocumentPart(doc: DocumentContent): Record<string, unknown> {
  if (doc.source.type === "base64") {
    // Responses API accepts a data URL in `file_data` for inline base64 files.
    // Limit: 50 MB per file.
    return {
      type: "input_file",
      filename: doc.filename ?? "document.pdf",
      file_data: `data:${doc.source.mediaType};base64,${doc.source.data}`,
    };
  }
  if (doc.source.type === "url") {
    return { type: "input_file", file_url: doc.source.url };
  }
  return { type: "input_file", file_id: doc.source.fileId };
}

/** Convert tool definitions to Responses API tool shape (flat, not nested). */
function toResponsesTools(
  tools?: ToolDefinition[],
): { type: "function"; name: string; description: string; parameters: unknown }[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Convert our messages to Responses API `input` items. */
function toResponsesInput(
  messages: Message[],
  system?: string,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];

  if (system) {
    items.push({
      role: "system",
      content: [{ type: "input_text", text: system }],
    });
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text: string }).text)
            .join("");
      items.push({ role: "system", content: [{ type: "input_text", text }] });
      continue;
    }

    if (msg.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const textParts = msg.content.filter((b) => b.type === "text");
      const toolParts = msg.content.filter((b) => b.type === "tool_use");
      if (textParts.length > 0) {
        items.push({
          role: "assistant",
          content: textParts.map((b) => ({
            type: "output_text",
            text: (b as { text: string }).text,
          })),
        });
      }
      for (const tu of toolParts) {
        const t = tu as { id: string; name: string; arguments: Record<string, unknown> };
        items.push({
          type: "function_call",
          call_id: t.id,
          name: t.name,
          arguments: JSON.stringify(t.arguments),
        });
      }
      continue;
    }

    // user / assistant string content, or user array content
    if (typeof msg.content === "string") {
      items.push({
        role: msg.role,
        content: [{ type: "input_text", text: msg.content }],
      });
      continue;
    }

    const content: Record<string, unknown>[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        content.push({ type: "input_text", text: block.text });
      } else if (block.type === "document") {
        content.push(toOpenAIDocumentPart(block));
      }
    }
    items.push({ role: msg.role, content });
  }

  return items;
}

/** Build Usage from a Responses API `response.usage` payload. */
function responsesUsage(raw: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
} | undefined): Usage | undefined {
  if (!raw) return undefined;
  const inputTokens = raw.input_tokens ?? 0;
  const outputTokens = raw.output_tokens ?? 0;
  const usage: Usage = {
    inputTokens,
    outputTokens,
    totalTokens: raw.total_tokens ?? inputTokens + outputTokens,
  };
  const cached = raw.input_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.cacheReadTokens = cached;
  return usage;
}

/** Build Usage from a Chat Completions `response.usage` payload. */
function chatUsage(raw: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
} | undefined): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = {
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? 0,
  };
  const cached = raw.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.cacheReadTokens = cached;
  return usage;
}

/**
 * Issue a non-streaming completion via the OpenAI Responses API.
 *
 * Used whenever the request contains a `document` content block, because the
 * Chat Completions endpoint does not accept file/PDF inputs.
 */
async function completeViaResponses(
  client: any,
  request: CompletionRequest,
  providerId: string,
): Promise<CompletionResponse> {
  const model = request.model;

  // Hoist any inline system messages so they become the leading `system` item.
  const messagesForInput = request.messages.filter((m) => m.role !== "system");
  const systemParts: string[] = [];
  if (request.system) systemParts.push(request.system);
  for (const m of request.messages) {
    if (m.role === "system") {
      systemParts.push(typeof m.content === "string"
        ? m.content
        : m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(""));
    }
  }
  const system = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  const response = await client.responses.create({
    model,
    input: toResponsesInput(messagesForInput, system),
    ...(request.tools ? { tools: toResponsesTools(request.tools) } : {}),
    ...(request.maxTokens ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.responseFormat === "json_object"
      ? { text: { format: { type: "json_object" } } }
      : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  });

  let text = "";
  const toolCalls: ToolCall[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text") text += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }

  // If the SDK already aggregated the text, prefer that.
  if (!text && typeof response.output_text === "string") {
    text = response.output_text;
  }

  return {
    text,
    toolCalls,
    done: toolCalls.length === 0,
    usage: responsesUsage(response.usage),
    providerId,
    model,
    finishReason: response.status,
  };
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

      if (hasDocuments(request.messages)) {
        if (!supportsResponsesApi(model)) {
          throw new Error(
            `Provider '${providerId}' model '${model}' does not support document inputs; ` +
              `use a model on the Responses API (gpt-5.x, gpt-4o, gpt-4.1).`,
          );
        }
        return completeViaResponses(c, request, providerId);
      }

      const response = await (c.chat.completions.create as Function)({
        model,
        messages: toOpenAIMessages(request.messages, request.system),
        tools: toOpenAITools(request.tools),
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        top_p: request.topP,
        stop: request.stop,
        ...(request.responseFormat === "json_object"
          ? { response_format: { type: "json_object" } }
          : {}),
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

      return {
        text: choice.message.content || "",
        toolCalls,
        done: toolCalls.length === 0,
        usage: chatUsage(response.usage),
        providerId,
        model,
        finishReason: choice.finish_reason,
      };
    },

    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const c = await getClient();
      const model = request.model;

      if (hasDocuments(request.messages)) {
        // The Responses API supports streaming, but llm-harness has not yet
        // mapped its event stream to the unified shape. Documents work via
        // complete() — escalate to that until streaming is implemented.
        yield {
          type: "error",
          error: new Error(
            `Provider '${providerId}' does not yet support streaming with document inputs. ` +
              `Use complete() for document requests.`,
          ),
        };
        return;
      }

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
        ...(request.responseFormat === "json_object"
          ? { response_format: { type: "json_object" } }
          : {}),
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
            usage = chatUsage(chunk.usage);
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
