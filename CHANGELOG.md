# Changelog

All notable changes to this project will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-05-14

### Added

- `DocumentContent` content block on `ContentBlock` — carries a PDF (or other document) by `base64`, `url`, or `file_id`. Anthropic translates it to a native `document` block. OpenAI routes the request to the Responses API and emits an `input_file` content part.
- `cacheable` flag on `CompletionRequest` — opt-in prompt caching for the system prompt. On Anthropic, this sends the system prompt as a `text` block with `cache_control: { type: "ephemeral" }`. On OpenAI, prompt caching is automatic on supported models and the flag is a no-op (kept for a unified contract).
- `Usage.cacheReadTokens` and `Usage.cacheCreationTokens` — cache token surfacing. Wired from Anthropic's `cache_read_input_tokens` / `cache_creation_input_tokens`, and from OpenAI's `prompt_tokens_details.cached_tokens` (Chat Completions) and `input_tokens_details.cached_tokens` (Responses API). `cacheCreationTokens` is Anthropic-only.

### Changed

- OpenAI provider transparently switches to the Responses API when any message contains a `DocumentContent` block. Legacy Chat Completions models throw a descriptive error (`Provider 'openai' model '<id>' does not support document inputs; use a model on the Responses API (gpt-5.x, gpt-4o, gpt-4.1).`).

### Not yet supported

- Streaming document inputs on OpenAI (use `complete()`).
- Document inputs on Google and Ollama.
- Structured outputs via `json_schema` strict mode and audio inputs.

### Backward compatibility

Additive. `DocumentContent` extends `ContentBlock`, `cacheable` is optional, and the new `Usage` fields are optional. Existing calls behave unchanged.

## [0.2.0] - 2026-04-27

### Added

- `responseFormat` field on `CompletionRequest` -- accepts `"text"` (default) or `"json_object"` to constrain the model to emit a single valid JSON object
- OpenAI provider forwards `responseFormat: "json_object"` natively as `response_format: { type: "json_object" }` in both `complete()` and `stream()`
- Anthropic provider implements JSON mode by appending a JSON-only instruction to the system prompt (the Anthropic API has no native equivalent flag)
- Google and Ollama providers forward `responseFormat` to their OpenAI-compatible endpoints automatically

### Backward compatibility

Fully backward compatible. `responseFormat` is optional; existing calls behave unchanged when it is omitted.

## [0.1.1] - 2026-04-07

### Added

- `streamReadable()` method on Router -- returns a Web `ReadableStream<Uint8Array>` for compatibility with Next.js Route Handlers, Hono, Cloudflare Workers, and the Fetch API
- `toReadableStream()` standalone utility -- converts any `AsyncIterable<StreamEvent>` to a ReadableStream
- Three serialization formats: `"json"` (NDJSON, default), `"sse"` (Server-Sent Events), `"raw"` (text deltas only)
- `StreamFormat` and `ReadableStreamOptions` types exported

## [0.1.0] - 2026-04-06

Initial release.

### Added

- `createRouter()` -- main entry point for creating a multi-provider LLM router
- Unified `complete()`, `stream()`, and `streamReadable()` API across all providers
- **OpenAI provider** -- supports GPT models, o-series, and any OpenAI-compatible endpoint
- **Anthropic provider** -- supports Claude models with native system prompt and tool calling
- **Google provider** -- supports Gemini models via Google's OpenAI-compatible endpoint
- **Ollama provider** -- supports local models via Ollama's OpenAI-compatible endpoint
- **OpenAI-compatible fallback** -- unknown provider IDs automatically use OpenAI-compatible adapter
- Automatic provider detection from model name patterns (e.g., `gpt-*` routes to OpenAI, `claude-*` to Anthropic)
- Model aliasing via the `models` routing table
- Failover chains via the `fallbacks` configuration
- Retry with exponential backoff, jitter, and `Retry-After` header support
- Circuit breaker per provider (5 failures trips, 60s cooldown)
- Usage tracking via `onUsage` callback with token counts, latency, and metadata
- Unified tool calling that works identically across all providers
- Streaming via async generators with typed events (`text_delta`, `tool_call_delta`, `complete`, `error`)
- Full TypeScript type definitions with no `any` leakage
- Provider SDKs are optional peer dependencies, loaded lazily via dynamic `import()`
- `ProviderRegistry` exported for advanced composition
- `withRetry`, `CircuitBreaker`, and `isRetryable` exported for custom provider implementations
