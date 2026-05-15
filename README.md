# llm-harness

**Zero-framework LLM router for Node.js.** Unified streaming, tool calling, and usage tracking across OpenAI, Anthropic, Google, Ollama, and any OpenAI-compatible provider.

[![npm version](https://img.shields.io/npm/v/llm-harness)](https://www.npmjs.com/package/llm-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178c6.svg)](https://www.typescriptlang.org/)

---

## Why?

Python has [LiteLLM](https://github.com/BerriAI/litellm). Node.js had nothing equivalent -- until now.

If you use multiple LLM providers, you know the pain: each SDK has its own message format, streaming protocol, tool calling convention, and error shape. `llm-harness` normalizes all of that behind a single interface. No framework lock-in, no magic, no runtime bloat. Just a router.

## Features

- **Unified interface** -- one `complete()` and `stream()` API for every provider
- **Dual streaming** -- async generators for Node.js, ReadableStream for Web (Next.js, Hono, Workers)
- **Tool calling** -- define tools once, they work across OpenAI, Anthropic, Google, and Ollama
- **Document inputs (PDFs)** -- attach files via `document` content blocks; Anthropic handles natively, OpenAI is routed to the Responses API automatically
- **Prompt caching** -- opt-in `cacheable` flag for system prompts; cache-token usage surfaced in `Usage.cacheReadTokens` / `cacheCreationTokens`
- **Automatic provider detection** -- route `gpt-4o` to OpenAI, `claude-sonnet-4-6` to Anthropic, `gemini-2.5-flash` to Google automatically
- **Model aliasing** -- map friendly names to specific model IDs
- **Failover chains** -- define fallback providers, tried in order when the primary fails
- **Retry with exponential backoff** -- configurable retries with jitter, respects `Retry-After` headers
- **Circuit breaker** -- automatically skips unhealthy providers, re-tests after cooldown
- **Usage tracking** -- `onUsage` callback fires on every completion with token counts and latency
- **Zero required dependencies** -- provider SDKs are optional peer dependencies, loaded lazily
- **TypeScript-first** -- complete type definitions, no `any` leakage

## Quick Start

```bash
npm install llm-harness

# Install only the provider SDKs you need:
npm install openai                  # for OpenAI, Ollama, or any OpenAI-compatible
npm install @anthropic-ai/sdk       # for Anthropic
```

```typescript
import { createRouter } from 'llm-harness';

const router = createRouter({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  },
  models: {
    'gpt-4o': 'openai',
    'claude-sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4-6-20250514' },
  },
});

const result = await router.complete({
  model: 'claude-sonnet',
  messages: [{ role: 'user', content: 'Explain quantum computing in one sentence.' }],
});

console.log(result.text);
// => "Quantum computing uses quantum mechanical phenomena..."
console.log(result.usage);
// => { inputTokens: 12, outputTokens: 18, totalTokens: 30 }
```

## Providers

| Provider | SDK Required | Auto-detected Patterns | Documents | Prompt cache | Notes |
|----------|-------------|----------------------|-----------|--------------|-------|
| OpenAI | `openai` | `gpt*`, `o1*`, `chatgpt*`, `openai/*` | Responses API only (`gpt-5.x`, `gpt-4o`, `gpt-4.1`, `o*`) | Automatic, `cacheReadTokens` surfaced | Default for unknown providers |
| Anthropic | `@anthropic-ai/sdk` | `claude*`, `anthropic/*` | Native `document` block | Opt-in via `cacheable: true` | System prompt handled natively |
| Google | `openai` | `gemini*`, `google/*` | Not yet supported | n/a | Uses Google's OpenAI-compatible endpoint |
| Ollama | `openai` | `llama*`, `meta/*`, `ollama/*` | Not yet supported | n/a | Defaults to `localhost:11434/v1` |
| Any OpenAI-compatible | `openai` | -- | Provider-dependent | Provider-dependent | Pass custom `baseUrl` |

Google and Ollama both use the OpenAI SDK under the hood via their OpenAI-compatible endpoints, so you only need `openai` installed for those.

Auto-detection also recognizes `mistral*`/`mixtral*`, `deepseek*`, and `command*` patterns, so those will route correctly if you register providers with matching IDs.

## Streaming

Two streaming APIs: **async generators** for Node.js control flow, and **ReadableStream** for Web-compatible responses (Next.js, Hono, Cloudflare Workers, Fetch API).

### Async Generator

```typescript
for await (const event of router.stream({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Write a haiku about TypeScript.' }],
})) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text);
      break;
    case 'tool_call_delta':
      // Incremental tool call data
      break;
    case 'complete':
      console.log('\nDone:', event.response.usage);
      break;
    case 'error':
      console.error('Stream error:', event.error);
      break;
  }
}
```

### ReadableStream (Web Streams API)

Use `streamReadable()` to get a `ReadableStream<Uint8Array>` — compatible with `new Response()`, Next.js Route Handlers, Hono, and any Web Streams consumer:

```typescript
// Next.js Route Handler
export async function POST(req: Request) {
  const { model, messages } = await req.json();

  return new Response(
    router.streamReadable({ model, messages }, { format: 'sse' }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
```

Three serialization formats:

| Format | Content-Type | Description |
|--------|-------------|-------------|
| `"json"` | `application/x-ndjson` | One JSON object per line (NDJSON). Default. |
| `"sse"` | `text/event-stream` | Server-Sent Events (`event: type\ndata: ...\n\n`). |
| `"raw"` | `text/plain` | Only text deltas as raw UTF-8 (no framing, no tool calls). |

You can also convert any async generator with the standalone `toReadableStream` utility:

```typescript
import { toReadableStream } from 'llm-harness';

const readable = toReadableStream(router.stream({ model, messages }), { format: 'sse' });
```

Stream events:

| Event | Fields | Description |
|-------|--------|-------------|
| `text_delta` | `text` | Incremental text chunk |
| `tool_call_delta` | `index`, `id?`, `name?`, `arguments?` | Incremental tool call data |
| `complete` | `response` | Final `CompletionResponse` with full text, tool calls, and usage |
| `error` | `error` | Error that occurred during streaming |

## Tool Calling

Define tools once. They work identically across OpenAI, Anthropic, Google, and Ollama:

```typescript
const result = await router.complete({
  model: 'claude-sonnet',
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
  tools: [{
    name: 'get_weather',
    description: 'Get current weather for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['location'],
    },
  }],
});

if (result.toolCalls.length > 0) {
  const call = result.toolCalls[0];
  console.log(call.name);       // "get_weather"
  console.log(call.arguments);  // '{"location":"Tokyo","unit":"celsius"}'
  console.log(result.done);     // false -- model wants tool results
}
```

To continue the conversation with tool results:

```typescript
const followUp = await router.complete({
  model: 'claude-sonnet',
  messages: [
    { role: 'user', content: 'What is the weather in Tokyo?' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: call.id, name: call.name, arguments: JSON.parse(call.arguments) },
    ]},
    { role: 'tool', toolCallId: call.id, content: '{"temp": 22, "condition": "sunny"}' },
  ],
  tools: [/* same tools */],
});

console.log(followUp.text);  // "The weather in Tokyo is sunny and 22 degrees..."
console.log(followUp.done);  // true
```

## Structured Output (JSON mode)

Set `responseFormat: 'json_object'` to constrain the model to emit a single valid JSON object. Useful when you need to `JSON.parse()` the response without defensive extraction.

```typescript
const result = await router.complete({
  model: 'gpt-5.4-nano',
  messages: [
    { role: 'user', content: 'Extract the title and priority. Respond as {"title": ..., "priority": ...}.' },
  ],
  responseFormat: 'json_object',
});

const parsed = JSON.parse(result.text);  // safe — guaranteed parseable JSON
```

**Provider behavior:**

| Provider | Implementation |
|----------|---------------|
| OpenAI | Native `response_format: { type: 'json_object' }` |
| Anthropic | Appends a JSON-only instruction to the system prompt (no native flag exists in the API) |
| Google | Forwarded as `response_format` to the OpenAI-compatible endpoint — honored where Gemini supports it; ignored otherwise |
| Ollama | Forwarded as `response_format` to the OpenAI-compatible endpoint — model-dependent |

**Notes:**

- Always describe the expected JSON shape in your prompt. `responseFormat` only constrains *parseability*, not schema.
- For OpenAI, the documented requirement that the prompt contain the word "JSON" still applies — the model will refuse otherwise. Including a JSON example in the system prompt is the safest pattern.
- For Anthropic, the appended instruction takes precedence over earlier conflicting guidance, but Claude is not bound by an API-level constraint — extremely adversarial prompts can still produce non-JSON output. Pair with try/catch.

## Document Inputs (PDFs)

Attach a PDF (or other document) to a message via a `document` content block. Anthropic accepts these natively; OpenAI routes them through the Responses API automatically.

```typescript
import { readFileSync } from 'node:fs';

const pdf = readFileSync('./resume.pdf').toString('base64');

const result = await router.complete({
  model: 'claude-sonnet-4-6',  // or 'gpt-4.1' / 'gpt-4o' / 'gpt-5.x'
  system: 'Extract the candidate\'s name, email, and most recent job title as JSON.',
  responseFormat: 'json_object',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Parse the attached resume.' },
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: pdf },
        filename: 'resume.pdf',
      },
    ],
  }],
});

console.log(JSON.parse(result.text));
```

Three source variants are supported:

| Source | Anthropic | OpenAI (Responses) |
|--------|-----------|--------------------|
| `{ type: 'base64', mediaType, data }` | `document` / `base64` | `input_file` with `file_data` (data URL) |
| `{ type: 'url', url }`                | `document` / `url`    | `input_file` with `file_url` |
| `{ type: 'file_id', fileId }`         | `document` / `file`   | `input_file` with `file_id` |

**Notes:**

- OpenAI's per-file limit is 50 MB. Anthropic's limit is 32 MB and 100 pages for `base64` and `url` documents.
- Document inputs on OpenAI require a Responses-API-capable model (`gpt-5.x`, `gpt-4o`, `gpt-4.1`, `o1`/`o3`/`o4`). Legacy models throw `Provider 'openai' model '<id>' does not support document inputs; use a model on the Responses API ...`.
- Streaming document inputs is not yet supported on OpenAI — use `complete()`.
- Google and Ollama do not yet accept document blocks.

## Prompt Caching

Set `cacheable: true` to opt into provider-side caching of the system prompt. Useful when the same large system prompt is reused across many requests.

```typescript
const result = await router.complete({
  model: 'claude-sonnet-4-6',
  system: longExtractionRubric,  // > 1024 tokens for a cache hit on Anthropic
  cacheable: true,
  messages: [{ role: 'user', content: 'Parse this.' }],
});

console.log(result.usage);
// => {
//   inputTokens: 12000,
//   outputTokens: 240,
//   totalTokens: 12240,
//   cacheReadTokens: 11800,     // bills at the cache-read rate
//   cacheCreationTokens: 0,     // 0 once the entry is warm
// }
```

**Provider behavior:**

| Provider | Implementation |
|----------|----------------|
| Anthropic | Sends the system prompt as a `text` block with `cache_control: { type: 'ephemeral' }`. Cache TTL is ~5 minutes. Minimum cacheable size is ~1024 tokens. |
| OpenAI | Prompt caching is automatic on supported models — the flag is a no-op. `usage.prompt_tokens_details.cached_tokens` is surfaced as `cacheReadTokens` regardless. |
| Google / Ollama | Flag is a no-op. |

`Usage` now exposes:

```typescript
interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;      // Anthropic cache_read_input_tokens / OpenAI cached_tokens
  cacheCreationTokens?: number;  // Anthropic cache_creation_input_tokens (Anthropic only)
}
```

## Failover and Retry

Configure fallback providers and retry behavior:

```typescript
const router = createRouter({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
  },
  // If the primary provider fails, try these in order:
  fallbacks: ['openai', 'anthropic'],
  // Retry configuration:
  retry: {
    maxRetries: 3,          // default: 3
    baseDelay: 1000,        // default: 1000ms
    maxDelay: 30000,        // default: 30000ms
    retryableStatuses: [429, 500, 502, 503, 529],  // defaults
  },
});
```

How it works:

1. The router resolves the model to a primary provider
2. If the call fails with a retryable error, it retries with exponential backoff + jitter
3. If retries are exhausted, it moves to the next provider in the fallback chain
4. A built-in circuit breaker tracks failures per provider -- after 5 consecutive failures, the provider is skipped for 60 seconds before being re-tested

Retryable errors: HTTP 429, 500, 502, 503, 529, and network errors (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`). The retry logic also respects `Retry-After` headers from the provider.

## Usage Tracking

Track token usage and latency across all providers:

```typescript
const router = createRouter({
  providers: { /* ... */ },
  onUsage: (event) => {
    console.log(`[${event.providerId}] ${event.model}`);
    console.log(`  Tokens: ${event.usage.totalTokens}`);
    console.log(`  Latency: ${event.durationMs}ms`);
    console.log(`  Success: ${event.success}`);
    // event.timestamp, event.metadata also available
  },
});
```

The `UsageEvent` type:

```typescript
interface UsageEvent {
  timestamp: string;        // ISO 8601
  providerId: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  durationMs: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

The callback fires for both `complete()` and `stream()` calls. For streaming, it fires when the stream completes (on the `complete` event).

## Custom / OpenAI-Compatible Providers

Any provider with an OpenAI-compatible API works out of the box. Just register it with a custom ID and `baseUrl`:

```typescript
const router = createRouter({
  providers: {
    // Together AI
    together: {
      apiKey: process.env.TOGETHER_API_KEY,
      baseUrl: 'https://api.together.xyz/v1',
    },
    // Groq
    groq: {
      apiKey: process.env.GROQ_API_KEY,
      baseUrl: 'https://api.groq.com/openai/v1',
    },
    // LM Studio (local)
    lmstudio: {
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'not-needed',
    },
  },
  models: {
    'llama-70b': 'together',
    'mixtral': 'groq',
    'local-model': 'lmstudio',
  },
});
```

When the router encounters a provider ID that is not one of the four built-in names (`openai`, `anthropic`, `ollama`, `google`), it automatically creates an OpenAI-compatible adapter using the provided configuration.

## API Reference

### `createRouter(config: RouterConfig): Router`

Creates a router instance.

**RouterConfig:**

| Field | Type | Description |
|-------|------|-------------|
| `providers` | `Record<string, ProviderConfig>` | Provider configurations keyed by ID |
| `models` | `Record<string, string \| ModelRoute>` | Model-to-provider routing table (optional -- auto-detection works without it) |
| `fallbacks` | `string[]` | Fallback provider chain, tried in order |
| `retry` | `RetryConfig` | Retry configuration |
| `onUsage` | `(event: UsageEvent) => void` | Usage tracking callback |

**ProviderConfig:**

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | `string` | API key |
| `baseUrl` | `string` | Base URL override |
| `organization` | `string` | Organization ID (OpenAI) |
| `defaultModel` | `string` | Default model for this provider |
| `options` | `Record<string, unknown>` | Additional provider-specific options |

**Router methods:**

| Method | Description |
|--------|-------------|
| `complete(request)` | Non-streaming completion. Returns `Promise<CompletionResponse>` |
| `stream(request)` | Streaming via async generator. Returns `AsyncGenerator<StreamEvent>` |
| `streamReadable(request, options?)` | Streaming via Web ReadableStream. Returns `ReadableStream<Uint8Array>` |
| `registry` | Access the underlying `ProviderRegistry` |

**CompletionRequest:**

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Model identifier |
| `messages` | `Message[]` | Conversation messages |
| `tools` | `ToolDefinition[]` | Available tools |
| `system` | `string` | System prompt |
| `maxTokens` | `number` | Maximum tokens to generate |
| `temperature` | `number` | Sampling temperature (0-2) |
| `topP` | `number` | Top-p nucleus sampling |
| `stop` | `string[]` | Stop sequences |
| `responseFormat` | `"text" \| "json_object"` | Constrain output to a single valid JSON object. See [Structured Output](#structured-output-json-mode) |
| `cacheable` | `boolean` | Opt in to provider-side caching of the system prompt. See [Prompt Caching](#prompt-caching) |
| `metadata` | `Record<string, unknown>` | Arbitrary metadata (passed through to `onUsage`) |

### Advanced Exports

For custom provider implementations or advanced composition:

```typescript
import {
  // Provider factories
  createOpenAIProvider,
  createAnthropicProvider,
  createOllamaProvider,
  createGoogleProvider,

  // Registry
  ProviderRegistry,

  // Retry utilities
  withRetry,
  CircuitBreaker,
  isRetryable,

  // Web Streams
  toReadableStream,
} from 'llm-harness';
```

## Comparison

| | llm-harness | LiteLLM | Vercel AI SDK |
|---|---|---|---|
| Language | TypeScript / Node.js | Python | TypeScript |
| Framework required | None | None | None (but React-oriented) |
| Streaming | Async generators + ReadableStream | Sync/async generators | ReadableStream |
| Tool calling | Unified across providers | Unified across providers | Unified across providers |
| Provider SDKs | Optional peer deps, lazy-loaded | Bundled | Bundled |
| Failover | Built-in with circuit breaker | Built-in | Manual |
| Usage tracking | Built-in callback | Built-in | Manual |
| Bundle overhead | Near zero (thin adapter layer) | N/A (Python) | Moderate |
| Custom providers | Any OpenAI-compatible endpoint | 100+ providers | Provider packages |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and how to add a new provider.

## License

[MIT](LICENSE) -- Brandon Korous
