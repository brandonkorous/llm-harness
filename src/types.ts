/**
 * Core type definitions for llm-harness.
 *
 * These types define the unified contract that all providers implement.
 * Application code works exclusively with these types — provider-specific
 * formats never leak beyond the adapter boundary.
 */

// ── Provider Identity ────────────────────────────────────────

export type ProviderId = string;

export interface ProviderConfig {
  /** API key for authentication. */
  apiKey?: string;
  /** Base URL override (for proxies, local deployments, etc.). */
  baseUrl?: string;
  /** Organization ID (OpenAI-specific). */
  organization?: string;
  /** Default model for this provider. */
  defaultModel?: string;
  /** Additional provider-specific options. */
  options?: Record<string, unknown>;
}

// ── Messages ─────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

/**
 * A document (typically a PDF) attached to a message.
 *
 * Anthropic accepts all three source variants natively as `document` blocks.
 * OpenAI accepts them only on the Responses API (`input_file` content parts).
 * Providers that do not support documents will throw a descriptive error.
 *
 * Size limits are provider-enforced — OpenAI is 50 MB per file; Anthropic is
 * 32 MB and 100 pages for inline `base64` and url documents.
 */
export interface DocumentContent {
  type: "document";
  source:
    | { type: "base64"; mediaType: string; data: string }
    | { type: "url"; url: string }
    | { type: "file_id"; fileId: string };
  /** Optional filename hint — used by OpenAI's `input_file` block. */
  filename?: string;
}

export type ContentBlock =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | DocumentContent;

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
  /** Tool call ID — present when role is "tool". */
  toolCallId?: string;
  /** Name of the tool — present when role is "tool". */
  name?: string;
}

// ── Tool Definitions ─────────────────────────────────────────

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter;
}

// ── Completion Request ───────────────────────────────────────

export interface CompletionRequest {
  /** Model identifier (resolved by the router). */
  model: string;
  /** Conversation messages. */
  messages: Message[];
  /** Available tools the model can call. */
  tools?: ToolDefinition[];
  /** System prompt (prepended or passed natively depending on provider). */
  system?: string;
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature (0-2). */
  temperature?: number;
  /** Top-p nucleus sampling. */
  topP?: number;
  /** Stop sequences. */
  stop?: string[];
  /** Whether to stream the response. */
  stream?: boolean;
  /**
   * Constrain the model to emit a specific output format.
   * - `"text"` (default): free-form text.
   * - `"json_object"`: a single valid JSON object. OpenAI uses native JSON
   *   mode; Anthropic injects an instruction into the system prompt because
   *   the API has no native equivalent. Callers should still describe the
   *   expected shape in their prompt — the format constraint only ensures
   *   the response is parseable, not that it matches a specific schema.
   */
  responseFormat?: "text" | "json_object";
  /**
   * Opt in to provider-side prompt caching for the system prompt.
   *
   * Anthropic: adds `cache_control: {type: 'ephemeral'}` to the system block.
   *   The minimum cacheable size is ~1024 tokens — smaller prompts will not
   *   produce a cache hit even with the flag set, so callers should only
   *   enable this when the system prompt is substantial and reused.
   *
   * OpenAI: cache hits are automatic on supported models; this flag has no
   *   effect (kept here for a unified contract).
   *
   * Default: false.
   */
  cacheable?: boolean;
  /** Arbitrary metadata passed to the provider (e.g., for tracking). */
  metadata?: Record<string, unknown>;
}

// ── Completion Response ──────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /**
   * Tokens served from the provider's prompt cache.
   *
   * - Anthropic: `usage.cache_read_input_tokens`
   * - OpenAI:    `usage.prompt_tokens_details.cached_tokens`
   *              (or `usage.input_tokens_details.cached_tokens` for the
   *              Responses API)
   *
   * Undefined when the provider did not report cache usage.
   */
  cacheReadTokens?: number;
  /**
   * Tokens written to the cache on this request.
   *
   * - Anthropic: `usage.cache_creation_input_tokens`
   * - OpenAI:    not reported separately — always undefined.
   */
  cacheCreationTokens?: number;
}

export interface CompletionResponse {
  /** The generated text content. */
  text: string;
  /** Tool calls requested by the model. */
  toolCalls: ToolCall[];
  /** Whether the model finished (no pending tool calls). */
  done: boolean;
  /** Token usage for this completion. */
  usage?: Usage;
  /** Which provider handled this request. */
  providerId: ProviderId;
  /** The actual model used (may differ from requested if aliased). */
  model: string;
  /** Provider-specific finish reason. */
  finishReason?: string;
}

// ── Streaming ────────────────────────────────────────────────

export interface StreamTextDelta {
  type: "text_delta";
  text: string;
}

export interface StreamToolCallDelta {
  type: "tool_call_delta";
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamComplete {
  type: "complete";
  response: CompletionResponse;
}

export interface StreamError {
  type: "error";
  error: Error;
}

export type StreamEvent =
  | StreamTextDelta
  | StreamToolCallDelta
  | StreamComplete
  | StreamError;

// ── Provider Interface ───────────────────────────────────────

/**
 * The contract every provider adapter must implement.
 * This is the Strategy pattern — each provider translates
 * the unified request/response to its native format.
 */
export interface LLMProvider {
  /** Unique provider identifier. */
  id: ProviderId;

  /** Complete a request (non-streaming). */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /** Stream a completion as an async generator of events. */
  stream(request: CompletionRequest): AsyncGenerator<StreamEvent>;
}

// ── Router Configuration ─────────────────────────────────────

export interface ModelRoute {
  /** Which provider handles this model. */
  provider: ProviderId;
  /** Actual model ID to send to the provider (if different from the route key). */
  modelId?: string;
}

export interface RetryConfig {
  /** Maximum retry attempts. Default: 3. */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff. Default: 1000. */
  baseDelay?: number;
  /** Maximum delay in ms. Default: 30000. */
  maxDelay?: number;
  /** HTTP status codes that trigger a retry. */
  retryableStatuses?: number[];
}

export interface RouterConfig {
  /** Provider configurations keyed by provider ID. */
  providers: Record<ProviderId, ProviderConfig>;
  /** Model-to-provider routing table. */
  models?: Record<string, ModelRoute | ProviderId>;
  /** Fallback provider chain (tried in order if primary fails). */
  fallbacks?: ProviderId[];
  /** Retry configuration. */
  retry?: RetryConfig;
  /** Called on every completion with usage data. */
  onUsage?: (usage: UsageEvent) => void;
}

// ── Usage Tracking ───────────────────────────────────────────

export interface UsageEvent {
  timestamp: string;
  providerId: ProviderId;
  model: string;
  usage: Usage;
  durationMs: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}
