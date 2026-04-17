import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/registry.js";
import type { LLMProvider } from "../src/types.js";

function fakeProvider(id: string): LLMProvider {
  return {
    id,
    complete: async () => ({
      text: "",
      toolCalls: [],
      done: true,
      providerId: id,
      model: "",
    }),
    async *stream() {
      // no-op
    },
  };
}

describe("ProviderRegistry", () => {
  describe("detectProvider", () => {
    it("detects Anthropic from claude-* models", () => {
      const r = new ProviderRegistry();
      expect(r.detectProvider("claude-sonnet-4-6")).toBe("anthropic");
      expect(r.detectProvider("anthropic/claude-opus")).toBe("anthropic");
    });

    it("detects OpenAI from gpt-*, o-series, chatgpt-*", () => {
      const r = new ProviderRegistry();
      expect(r.detectProvider("gpt-4o")).toBe("openai");
      expect(r.detectProvider("gpt-5-nano")).toBe("openai");
      expect(r.detectProvider("o1-preview")).toBe("openai");
      expect(r.detectProvider("chatgpt-4o-latest")).toBe("openai");
      expect(r.detectProvider("openai/gpt-4")).toBe("openai");
    });

    it("detects Google from gemini-* models", () => {
      const r = new ProviderRegistry();
      expect(r.detectProvider("gemini-2.5-flash")).toBe("google");
    });

    it("detects Ollama from llama-* and meta/* names", () => {
      const r = new ProviderRegistry();
      expect(r.detectProvider("llama3")).toBe("ollama");
      expect(r.detectProvider("meta/llama-3-70b")).toBe("ollama");
      expect(r.detectProvider("ollama/mixtral")).toBe("ollama");
    });

    it("detects mistral/deepseek/cohere", () => {
      const r = new ProviderRegistry();
      expect(r.detectProvider("mistral-large")).toBe("mistral");
      expect(r.detectProvider("mixtral-8x7b")).toBe("mistral");
      expect(r.detectProvider("deepseek-chat")).toBe("deepseek");
      expect(r.detectProvider("command-r-plus")).toBe("cohere");
    });

    it("returns null for unknown model names", () => {
      const r = new ProviderRegistry();
      expect(r.detectProvider("unknown-model")).toBeNull();
    });
  });

  describe("registerInstance / resolve / list / has", () => {
    it("registers and resolves a provider instance", () => {
      const r = new ProviderRegistry();
      const p = fakeProvider("openai");
      r.registerInstance(p);
      expect(r.resolve("openai")).toBe(p);
      expect(r.has("openai")).toBe(true);
      expect(r.list()).toContain("openai");
    });

    it("throws when resolving an unregistered provider", () => {
      const r = new ProviderRegistry();
      expect(() => r.resolve("openai")).toThrow(/not registered/);
    });

    it("tryResolve returns null for missing providers", () => {
      const r = new ProviderRegistry();
      expect(r.tryResolve("missing")).toBeNull();
    });
  });

  describe("registerFactory / register", () => {
    it("instantiates a provider from a registered factory", () => {
      const r = new ProviderRegistry();
      r.registerFactory("openai", () => fakeProvider("openai"));
      const p = r.register("openai", { apiKey: "sk-test" });
      expect(p.id).toBe("openai");
      expect(r.has("openai")).toBe(true);
    });

    it("throws when registering without a factory", () => {
      const r = new ProviderRegistry();
      expect(() => r.register("openai", {})).toThrow(/No factory/);
    });
  });
});
