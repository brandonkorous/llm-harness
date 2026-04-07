/**
 * Provider Registry — maps provider IDs to adapter instances.
 *
 * Uses the Registry pattern to resolve providers by ID and auto-detect
 * the right provider for a model based on naming conventions.
 */

import type { LLMProvider, ProviderId, ProviderConfig } from "./types.js";

/** Factory function that creates a provider from config. */
export type ProviderFactory = (config: ProviderConfig) => LLMProvider;

/** Built-in model name → provider detection rules. */
const MODEL_PATTERNS: [RegExp, ProviderId][] = [
  // Anthropic / Claude
  [/^claude/i, "anthropic"],
  [/^anthropic\//i, "anthropic"],
  // OpenAI
  [/^gpt/i, "openai"],
  [/^o[1-9]/i, "openai"],
  [/^chatgpt/i, "openai"],
  [/^openai\//i, "openai"],
  // Google
  [/^gemini/i, "google"],
  [/^google\//i, "google"],
  // Meta / Llama (typically via Ollama or compatible)
  [/^llama/i, "ollama"],
  [/^meta\//i, "ollama"],
  // Mistral
  [/^mistral/i, "mistral"],
  [/^mixtral/i, "mistral"],
  // DeepSeek
  [/^deepseek/i, "deepseek"],
  // Cohere
  [/^command/i, "cohere"],
  // Ollama explicit
  [/^ollama\//i, "ollama"],
];

export class ProviderRegistry {
  private providers = new Map<ProviderId, LLMProvider>();
  private factories = new Map<ProviderId, ProviderFactory>();

  /** Register a provider factory (called before createRouter). */
  registerFactory(id: ProviderId, factory: ProviderFactory): void {
    this.factories.set(id, factory);
  }

  /** Instantiate a provider from config and register it. */
  register(id: ProviderId, config: ProviderConfig): LLMProvider {
    const factory = this.factories.get(id);
    if (!factory) {
      throw new Error(
        `No factory registered for provider "${id}". ` +
        `Available: ${[...this.factories.keys()].join(", ")}`,
      );
    }
    const provider = factory(config);
    this.providers.set(id, provider);
    return provider;
  }

  /** Register a pre-built provider instance directly. */
  registerInstance(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Resolve a provider by ID. Throws if not found. */
  resolve(id: ProviderId): LLMProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(
        `Provider "${id}" not registered. ` +
        `Available: ${[...this.providers.keys()].join(", ")}`,
      );
    }
    return provider;
  }

  /** Try to resolve a provider, return null if not found. */
  tryResolve(id: ProviderId): LLMProvider | null {
    return this.providers.get(id) ?? null;
  }

  /** Auto-detect provider ID from a model name using built-in patterns. */
  detectProvider(model: string): ProviderId | null {
    for (const [pattern, providerId] of MODEL_PATTERNS) {
      if (pattern.test(model)) return providerId;
    }
    return null;
  }

  /** List all registered provider IDs. */
  list(): ProviderId[] {
    return [...this.providers.keys()];
  }

  /** Check if a provider is registered. */
  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }
}
