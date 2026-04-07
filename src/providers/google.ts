/**
 * Google Gemini provider adapter.
 *
 * Google provides an OpenAI-compatible endpoint at:
 *   https://generativelanguage.googleapis.com/v1beta/openai/
 *
 * This adapter reuses the OpenAI provider with Google's compatibility
 * endpoint, handling model name normalization.
 */

import type { LLMProvider, ProviderConfig, CompletionRequest, CompletionResponse, StreamEvent } from "../types.js";
import { createOpenAIProvider } from "./openai.js";

const GOOGLE_OPENAI_COMPAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export function createGoogleProvider(config: ProviderConfig): LLMProvider {
  const inner = createOpenAIProvider(
    {
      ...config,
      baseUrl: config.baseUrl || GOOGLE_OPENAI_COMPAT_URL,
    },
    "google",
  );

  /** Strip "google/" prefix from model names. */
  function normalizeModel(model: string): string {
    return model.replace(/^google\//i, "");
  }

  return {
    id: "google",

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      return inner.complete({ ...request, model: normalizeModel(request.model) });
    },

    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      yield* inner.stream({ ...request, model: normalizeModel(request.model) });
    },
  };
}
