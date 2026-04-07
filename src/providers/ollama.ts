/**
 * Ollama provider adapter.
 *
 * Ollama exposes an OpenAI-compatible API at /v1/, so this adapter
 * reuses the OpenAI provider with a custom base URL.
 * Handles Ollama-specific model name stripping (e.g., "ollama/llama3" → "llama3").
 */

import type { LLMProvider, ProviderConfig, CompletionRequest, CompletionResponse, StreamEvent } from "../types.js";
import { createOpenAIProvider } from "./openai.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434/v1";

export function createOllamaProvider(config: ProviderConfig): LLMProvider {
  const inner = createOpenAIProvider(
    {
      ...config,
      baseUrl: config.baseUrl || DEFAULT_OLLAMA_URL,
      // Ollama doesn't require an API key, but the OpenAI SDK wants one
      apiKey: config.apiKey || "ollama",
    },
    "ollama",
  );

  /** Strip "ollama/" prefix from model names. */
  function normalizeModel(model: string): string {
    return model.replace(/^ollama\//i, "");
  }

  return {
    id: "ollama",

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      return inner.complete({ ...request, model: normalizeModel(request.model) });
    },

    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      yield* inner.stream({ ...request, model: normalizeModel(request.model) });
    },
  };
}
