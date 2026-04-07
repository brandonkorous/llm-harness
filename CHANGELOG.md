# Changelog

All notable changes to this project will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-06

Initial release.

### Added

- `createRouter()` -- main entry point for creating a multi-provider LLM router
- Unified `complete()` and `stream()` API across all providers
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
