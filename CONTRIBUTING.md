# Contributing to llm-harness

Thanks for your interest in contributing. This document covers the development workflow, code conventions, and how to add new providers.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/brandonkorous/llm-harness.git
cd llm-harness

# Install dependencies
npm install

# Build
npm run build

# Type-check without emitting
npm run lint

# Run tests
npm test

# Watch mode for development
npm run dev          # tsc --watch
npm run test:watch   # vitest watch
```

### Prerequisites

- Node.js >= 18
- npm >= 9

## Project Structure

```
src/
  index.ts           # Public API surface
  types.ts           # All shared type definitions
  router.ts          # createRouter() and Router interface
  registry.ts        # ProviderRegistry and model auto-detection
  retry.ts           # withRetry, CircuitBreaker, isRetryable
  providers/
    index.ts         # Re-exports all provider factories
    openai.ts        # OpenAI + OpenAI-compatible adapter
    anthropic.ts     # Anthropic/Claude adapter
    ollama.ts        # Ollama adapter (wraps OpenAI provider)
    google.ts        # Google Gemini adapter (wraps OpenAI provider)
```

## Running Tests

```bash
# Run all tests once
npm test

# Watch mode
npm run test:watch
```

Tests use [Vitest](https://vitest.dev). Place test files in a dedicated `tests/` directory at the project root (not colocated with source files).

## Code Style

- TypeScript strict mode is enabled
- Use ESM (`import`/`export`) throughout
- Avoid `any` -- use `unknown` and narrow with type guards
- Prefer named exports over default exports
- Keep provider adapters self-contained -- no cross-provider imports (except Ollama and Google wrapping the OpenAI adapter)
- Provider SDKs must be dynamically imported (`await import(...)`) so they remain optional

## How to Add a New Provider

Adding a provider requires three steps:

### 1. Create the adapter

Create `src/providers/<name>.ts` implementing the `LLMProvider` interface:

```typescript
import type {
  LLMProvider,
  ProviderConfig,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "../types.js";

export function create<Name>Provider(config: ProviderConfig): LLMProvider {
  return {
    id: "<name>",

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      // Convert request to provider's native format
      // Call the provider's API
      // Convert response back to CompletionResponse
    },

    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      // Convert request to provider's native format
      // Stream from the provider's API
      // Yield StreamEvent objects (text_delta, tool_call_delta, complete, error)
    },
  };
}
```

If the provider has an OpenAI-compatible API, you can wrap `createOpenAIProvider` with a custom base URL (see `ollama.ts` or `google.ts` for examples).

If the provider requires its own SDK, dynamically import it and throw a clear error message if it is not installed:

```typescript
async function getSDK() {
  try {
    return await import("provider-sdk");
  } catch {
    throw new Error(
      'Provider requires the "provider-sdk" package. Install it: npm install provider-sdk'
    );
  }
}
```

### 2. Register the adapter

Add your factory export to `src/providers/index.ts`:

```typescript
export { create<Name>Provider } from "./<name>.js";
```

Export it from `src/index.ts`:

```typescript
export { create<Name>Provider } from "./providers/index.js";
```

Add the factory to the `BUILT_IN_FACTORIES` map in `src/router.ts`:

```typescript
const BUILT_IN_FACTORIES: Record<string, (config: any) => any> = {
  // ... existing providers
  "<name>": (config) => create<Name>Provider(config),
};
```

### 3. Add auto-detection patterns

If the provider has recognizable model name patterns, add them to `MODEL_PATTERNS` in `src/registry.ts`:

```typescript
const MODEL_PATTERNS: [RegExp, ProviderId][] = [
  // ... existing patterns
  [/^<pattern>/i, "<name>"],
];
```

### 4. Add the peer dependency

If the provider needs its own SDK, add it to `peerDependencies` and `peerDependenciesMeta` (as optional) in `package.json`, and to `devDependencies` for local development.

### 5. Write tests

Add tests in `tests/` covering both `complete()` and `stream()` paths. Mock the provider SDK -- do not make real API calls in tests.

## Pull Request Process

1. Fork the repository and create a branch from `main`
2. Make your changes
3. Ensure all tests pass: `npm test`
4. Ensure type-checking passes: `npm run lint`
5. Write a clear PR description explaining what changed and why
6. If adding a new provider, include the four steps above (adapter, registration, auto-detection, tests)

## Reporting Issues

Use the [GitHub issue templates](https://github.com/brandonkorous/llm-harness/issues/new/choose) for bug reports and feature requests.
