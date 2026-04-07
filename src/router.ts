/**
 * LLM Router — the main entry point for llm-harness.
 *
 * Creates a router that resolves model names to providers,
 * handles failover, retry, and usage tracking.
 *
 * Usage:
 *   const router = createRouter({
 *     providers: {
 *       openai: { apiKey: "sk-..." },
 *       anthropic: { apiKey: "sk-ant-..." },
 *       ollama: { baseUrl: "http://localhost:11434/v1" },
 *       google: { apiKey: "..." },
 *     },
 *     models: {
 *       "gpt-5-nano": "openai",
 *       "claude-sonnet-4-6": { provider: "anthropic", modelId: "claude-sonnet-4-6-20250514" },
 *       "llama3": "ollama",
 *       "gemini-2.5-flash": "google",
 *     },
 *   });
 *
 *   // Non-streaming
 *   const result = await router.complete({ model: "claude-sonnet-4-6", messages: [...] });
 *
 *   // Streaming
 *   for await (const event of router.stream({ model: "gpt-5-nano", messages: [...] })) {
 *     if (event.type === "text_delta") process.stdout.write(event.text);
 *   }
 */

import type {
  RouterConfig,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
  ProviderId,
  ModelRoute,
  UsageEvent,
} from "./types.js";
import { ProviderRegistry } from "./registry.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createOllamaProvider } from "./providers/ollama.js";
import { createGoogleProvider } from "./providers/google.js";
import { withRetry, CircuitBreaker } from "./retry.js";

// ── Built-in provider factories ──────────────────────────────

const BUILT_IN_FACTORIES: Record<string, (config: any) => any> = {
  openai: (config) => createOpenAIProvider(config),
  anthropic: (config) => createAnthropicProvider(config),
  ollama: (config) => createOllamaProvider(config),
  google: (config) => createGoogleProvider(config),
};

// ── Router ───────────────────────────────────────────────────

export interface Router {
  /** Complete a request (non-streaming). Resolves model → provider automatically. */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /** Stream a completion. Resolves model → provider automatically. */
  stream(request: CompletionRequest): AsyncGenerator<StreamEvent>;
  /** Access the underlying provider registry. */
  registry: ProviderRegistry;
}

export function createRouter(config: RouterConfig): Router {
  const registry = new ProviderRegistry();
  const breaker = new CircuitBreaker();

  // Register built-in factory providers
  for (const [id, providerConfig] of Object.entries(config.providers)) {
    const factory = BUILT_IN_FACTORIES[id];
    if (factory) {
      registry.registerInstance(factory(providerConfig));
    } else {
      // For unknown provider IDs, try OpenAI-compatible as default
      registry.registerInstance(createOpenAIProvider(providerConfig, id));
    }
  }

  /** Resolve which provider handles a model and what model ID to use. */
  function resolveModel(model: string): { providerId: ProviderId; modelId: string } {
    // Check explicit model routes first
    if (config.models) {
      const route = config.models[model];
      if (route) {
        if (typeof route === "string") {
          return { providerId: route, modelId: model };
        }
        return { providerId: route.provider, modelId: route.modelId || model };
      }
    }

    // Auto-detect from model name patterns
    const detected = registry.detectProvider(model);
    if (detected && registry.has(detected)) {
      return { providerId: detected, modelId: model };
    }

    // Fall back to first registered provider
    const available = registry.list();
    if (available.length > 0) {
      return { providerId: available[0], modelId: model };
    }

    throw new Error(`Cannot resolve provider for model "${model}". No providers registered.`);
  }

  /** Get provider chain: primary + fallbacks. */
  function getProviderChain(primaryId: ProviderId): ProviderId[] {
    const chain = [primaryId];
    if (config.fallbacks) {
      for (const fb of config.fallbacks) {
        if (fb !== primaryId && registry.has(fb)) {
          chain.push(fb);
        }
      }
    }
    return chain;
  }

  /** Emit usage event if callback is configured. */
  function emitUsage(
    providerId: ProviderId,
    model: string,
    response: CompletionResponse,
    durationMs: number,
    metadata?: Record<string, unknown>,
  ): void {
    if (!config.onUsage) return;
    config.onUsage({
      timestamp: new Date().toISOString(),
      providerId,
      model,
      usage: response.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      durationMs,
      success: true,
      metadata,
    });
  }

  return {
    registry,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const { providerId, modelId } = resolveModel(request.model);
      const chain = getProviderChain(providerId);

      for (const pid of chain) {
        if (!breaker.isHealthy(pid)) continue;

        const provider = registry.resolve(pid);
        const start = Date.now();

        try {
          const response = await withRetry(
            () => provider.complete({ ...request, model: modelId }),
            config.retry,
          );

          breaker.recordSuccess(pid);
          emitUsage(pid, modelId, response, Date.now() - start, request.metadata);
          return response;
        } catch (error) {
          breaker.recordFailure(pid);
          // If this is the last in the chain, throw
          if (pid === chain[chain.length - 1]) throw error;
          // Otherwise try next fallback
        }
      }

      throw new Error(`All providers failed for model "${request.model}"`);
    },

    async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
      const { providerId, modelId } = resolveModel(request.model);
      const chain = getProviderChain(providerId);

      for (const pid of chain) {
        if (!breaker.isHealthy(pid)) continue;

        const provider = registry.resolve(pid);
        const start = Date.now();

        try {
          for await (const event of provider.stream({ ...request, model: modelId })) {
            if (event.type === "complete") {
              breaker.recordSuccess(pid);
              emitUsage(pid, modelId, event.response, Date.now() - start, request.metadata);
            }
            yield event;
          }
          return; // Success — don't try fallbacks
        } catch (error) {
          breaker.recordFailure(pid);
          if (pid === chain[chain.length - 1]) {
            yield { type: "error", error: error instanceof Error ? error : new Error(String(error)) };
            return;
          }
          // Try next fallback
        }
      }
    },
  };
}
