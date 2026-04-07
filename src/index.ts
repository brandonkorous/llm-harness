/**
 * llm-harness — Zero-framework LLM router for Node.js.
 *
 * Unified streaming, tool calling, and usage tracking across
 * OpenAI, Anthropic, Google, Ollama, and any OpenAI-compatible provider.
 *
 * @example
 * ```typescript
 * import { createRouter } from 'llm-harness';
 *
 * const router = createRouter({
 *   providers: {
 *     openai: { apiKey: process.env.OPENAI_API_KEY },
 *     anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
 *     ollama: { baseUrl: 'http://localhost:11434/v1' },
 *     google: { apiKey: process.env.GOOGLE_API_KEY },
 *   },
 *   models: {
 *     'gpt-5-nano': 'openai',
 *     'claude-sonnet-4-6': { provider: 'anthropic', modelId: 'claude-sonnet-4-6-20250514' },
 *     'llama3': 'ollama',
 *     'gemini-2.5-flash': 'google',
 *   },
 *   fallbacks: ['openai', 'anthropic'],
 *   onUsage: (event) => console.log(`${event.model}: ${event.usage.totalTokens} tokens`),
 * });
 *
 * // Streaming
 * for await (const event of router.stream({
 *   model: 'claude-sonnet-4-6',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 * })) {
 *   if (event.type === 'text_delta') process.stdout.write(event.text);
 * }
 *
 * // Non-streaming
 * const result = await router.complete({
 *   model: 'gpt-5-nano',
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   tools: [{ name: 'get_weather', description: '...', parameters: { ... } }],
 * });
 * ```
 */

// Main entry point
export { createRouter, type Router } from "./router.js";

// Types
export type {
  // Provider
  ProviderId,
  ProviderConfig,
  LLMProvider,

  // Messages
  MessageRole,
  Message,
  ContentBlock,
  TextContent,
  ToolUseContent,
  ToolResultContent,

  // Tools
  ToolDefinition,
  ToolParameter,
  ToolCall,

  // Request / Response
  CompletionRequest,
  CompletionResponse,
  Usage,

  // Streaming
  StreamEvent,
  StreamTextDelta,
  StreamToolCallDelta,
  StreamComplete,
  StreamError,

  // Router config
  RouterConfig,
  ModelRoute,
  RetryConfig,

  // Usage tracking
  UsageEvent,
} from "./types.js";

// Provider factories (for custom composition)
export {
  createOpenAIProvider,
  createAnthropicProvider,
  createOllamaProvider,
  createGoogleProvider,
} from "./providers/index.js";

// Registry (for advanced usage)
export { ProviderRegistry } from "./registry.js";

// Retry utilities (for custom providers)
export { withRetry, CircuitBreaker, isRetryable } from "./retry.js";

// Web Streams utilities
export { toReadableStream, type StreamFormat, type ReadableStreamOptions } from "./streams.js";
