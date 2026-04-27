import { describe, it, expect, vi } from "vitest";
import { createRouter } from "../src/router.js";
import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
  StreamEvent,
} from "../src/types.js";

interface FakeProviderOptions {
  id: string;
  response?: Partial<CompletionResponse>;
  streamEvents?: StreamEvent[];
  failWith?: unknown;
  streamFailWith?: unknown;
}

function fakeProvider(opts: FakeProviderOptions): LLMProvider & {
  completeCalls: CompletionRequest[];
  streamCalls: CompletionRequest[];
} {
  const completeCalls: CompletionRequest[] = [];
  const streamCalls: CompletionRequest[] = [];

  return {
    id: opts.id,
    completeCalls,
    streamCalls,
    async complete(request) {
      completeCalls.push(request);
      if (opts.failWith) throw opts.failWith;
      return {
        text: "fake-text",
        toolCalls: [],
        done: true,
        providerId: opts.id,
        model: request.model,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        ...opts.response,
      };
    },
    async *stream(request) {
      streamCalls.push(request);
      if (opts.streamFailWith) throw opts.streamFailWith;
      const events: StreamEvent[] = opts.streamEvents ?? [
        { type: "text_delta", text: "hi" },
        {
          type: "complete",
          response: {
            text: "hi",
            toolCalls: [],
            done: true,
            providerId: opts.id,
            model: request.model,
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        },
      ];
      for (const e of events) yield e;
    },
  };
}

/** Build a router with fake providers injected directly into the registry. */
function buildRouterWith(
  providers: ReturnType<typeof fakeProvider>[],
  extra: Parameters<typeof createRouter>[0] = { providers: {} },
) {
  // We pass a dummy provider config so createRouter instantiates *something*,
  // then overwrite the registry with our fakes. The built-in OpenAI adapter
  // is lazy (no network) so registering it is harmless.
  const router = createRouter({
    ...extra,
    providers: {
      ...Object.fromEntries(providers.map((p) => [p.id, { apiKey: "test" }])),
      ...extra.providers,
    },
  });
  for (const p of providers) {
    router.registry.registerInstance(p);
  }
  return router;
}

async function collectStream(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("createRouter.complete", () => {
  it("routes via explicit models map (string form)", async () => {
    const openai = fakeProvider({ id: "openai" });
    const anthropic = fakeProvider({ id: "anthropic" });
    const router = buildRouterWith([openai, anthropic], {
      providers: { openai: { apiKey: "x" }, anthropic: { apiKey: "y" } },
      models: { "my-gpt": "openai" },
    });

    const res = await router.complete({
      model: "my-gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.providerId).toBe("openai");
    expect(openai.completeCalls).toHaveLength(1);
    expect(anthropic.completeCalls).toHaveLength(0);
  });

  it("rewrites model id when models map specifies modelId", async () => {
    const anthropic = fakeProvider({ id: "anthropic" });
    const router = buildRouterWith([anthropic], {
      providers: { anthropic: { apiKey: "y" } },
      models: {
        "claude-sonnet": {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6-20250514",
        },
      },
    });

    await router.complete({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(anthropic.completeCalls[0].model).toBe("claude-sonnet-4-6-20250514");
  });

  it("auto-detects provider from model name when no explicit mapping", async () => {
    const openai = fakeProvider({ id: "openai" });
    const anthropic = fakeProvider({ id: "anthropic" });
    const router = buildRouterWith([openai, anthropic], {
      providers: { openai: { apiKey: "x" }, anthropic: { apiKey: "y" } },
    });

    await router.complete({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(anthropic.completeCalls).toHaveLength(1);
    expect(openai.completeCalls).toHaveLength(0);
  });

  it("falls through to next provider on failure", async () => {
    const broken = fakeProvider({
      id: "openai",
      failWith: { status: 500, message: "boom" },
    });
    const healthy = fakeProvider({ id: "anthropic" });
    const router = buildRouterWith([broken, healthy], {
      providers: { openai: { apiKey: "x" }, anthropic: { apiKey: "y" } },
      models: { "my-model": "openai" },
      fallbacks: ["anthropic"],
      retry: { maxRetries: 0 },
    });

    const res = await router.complete({
      model: "my-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.providerId).toBe("anthropic");
    expect(broken.completeCalls).toHaveLength(1);
    expect(healthy.completeCalls).toHaveLength(1);
  });

  it("throws when all providers in the chain fail", async () => {
    const a = fakeProvider({ id: "openai", failWith: new Error("a-fail") });
    const b = fakeProvider({ id: "anthropic", failWith: new Error("b-fail") });
    const router = buildRouterWith([a, b], {
      providers: { openai: { apiKey: "x" }, anthropic: { apiKey: "y" } },
      models: { "x": "openai" },
      fallbacks: ["anthropic"],
      retry: { maxRetries: 0 },
    });

    await expect(
      router.complete({
        model: "x",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/b-fail/);
  });

  it("invokes onUsage with token counts and metadata", async () => {
    const onUsage = vi.fn();
    const openai = fakeProvider({ id: "openai" });
    const router = buildRouterWith([openai], {
      providers: { openai: { apiKey: "x" } },
      models: { "gpt": "openai" },
      onUsage,
    });

    await router.complete({
      model: "gpt",
      messages: [{ role: "user", content: "hi" }],
      metadata: { requestId: "abc" },
    });

    expect(onUsage).toHaveBeenCalledOnce();
    const event = onUsage.mock.calls[0][0];
    expect(event.providerId).toBe("openai");
    expect(event.usage.totalTokens).toBe(30);
    expect(event.metadata).toEqual({ requestId: "abc" });
    expect(typeof event.durationMs).toBe("number");
  });

  it("throws a descriptive error when no providers are registered", async () => {
    const router = createRouter({ providers: {} });
    await expect(
      router.complete({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/No providers registered/);
  });

  it("forwards responseFormat to the resolved provider", async () => {
    const openai = fakeProvider({ id: "openai" });
    const router = buildRouterWith([openai], {
      providers: { openai: { apiKey: "x" } },
      models: { gpt: "openai" },
    });

    await router.complete({
      model: "gpt",
      messages: [{ role: "user", content: "give me JSON" }],
      responseFormat: "json_object",
    });

    expect(openai.completeCalls[0].responseFormat).toBe("json_object");
  });
});

describe("createRouter.stream", () => {
  it("yields events from the resolved provider", async () => {
    const openai = fakeProvider({ id: "openai" });
    const router = buildRouterWith([openai], {
      providers: { openai: { apiKey: "x" } },
      models: { "gpt": "openai" },
    });

    const events = await collectStream(
      router.stream({
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "complete")).toBe(true);
  });

  it("invokes onUsage when the complete event fires", async () => {
    const onUsage = vi.fn();
    const openai = fakeProvider({ id: "openai" });
    const router = buildRouterWith([openai], {
      providers: { openai: { apiKey: "x" } },
      models: { "gpt": "openai" },
      onUsage,
    });

    await collectStream(
      router.stream({
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it("yields an error event when the only provider fails", async () => {
    const broken = fakeProvider({
      id: "openai",
      streamFailWith: new Error("stream-fail"),
    });
    const router = buildRouterWith([broken], {
      providers: { openai: { apiKey: "x" } },
      models: { "gpt": "openai" },
    });

    const events = await collectStream(
      router.stream({
        model: "gpt",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeDefined();
    expect((errEvent as { error: Error }).error.message).toMatch(/stream-fail/);
  });
});

describe("createRouter.streamReadable", () => {
  it("returns a ReadableStream that emits serialized events", async () => {
    const openai = fakeProvider({ id: "openai" });
    const router = buildRouterWith([openai], {
      providers: { openai: { apiKey: "x" } },
      models: { "gpt": "openai" },
    });

    const stream = router.streamReadable({
      model: "gpt",
      messages: [{ role: "user", content: "hi" }],
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
