import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks for the dynamically-imported provider SDKs ─────────

const anthropicCreate = vi.fn();
const anthropicStream = vi.fn();
const openaiChatCreate = vi.fn();
const openaiResponsesCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    public messages = {
      create: anthropicCreate,
      stream: anthropicStream,
    };
    // The real SDK takes an options object; we accept anything.
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});

vi.mock("openai", () => {
  class FakeOpenAI {
    public chat = { completions: { create: openaiChatCreate } };
    public responses = { create: openaiResponsesCreate };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeOpenAI };
});

// Imports must come after the mocks so the provider adapters pick them up.
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import type {
  CompletionRequest,
  DocumentContent,
  Message,
} from "../src/types.js";

beforeEach(() => {
  anthropicCreate.mockReset();
  anthropicStream.mockReset();
  openaiChatCreate.mockReset();
  openaiResponsesCreate.mockReset();
});

// ── Helpers ─────────────────────────────────────────────────

function pdfDocBase64(): DocumentContent {
  return {
    type: "document",
    source: { type: "base64", mediaType: "application/pdf", data: "JVBERi0xLjQK" },
    filename: "resume.pdf",
  };
}

function pdfDocUrl(): DocumentContent {
  return {
    type: "document",
    source: { type: "url", url: "https://example.com/resume.pdf" },
  };
}

function pdfDocFileId(): DocumentContent {
  return {
    type: "document",
    source: { type: "file_id", fileId: "file_abc" },
  };
}

function userWithDoc(doc: DocumentContent): Message {
  return {
    role: "user",
    content: [{ type: "text", text: "Summarize this resume." }, doc],
  };
}

// ── Anthropic ───────────────────────────────────────────────

describe("Anthropic provider — document blocks", () => {
  it("translates base64 documents to Anthropic's base64 source shape", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 1 },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    await provider.complete({
      model: "claude-sonnet-4-6",
      messages: [userWithDoc(pdfDocBase64())],
    });

    const call = anthropicCreate.mock.calls[0][0];
    const userMsg = call.messages[0];
    expect(userMsg.role).toBe("user");
    const docBlock = userMsg.content.find((b: { type: string }) => b.type === "document");
    expect(docBlock).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "JVBERi0xLjQK",
      },
    });
  });

  it("translates url documents to Anthropic's url source shape", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    await provider.complete({
      model: "claude-sonnet-4-6",
      messages: [userWithDoc(pdfDocUrl())],
    });

    const docBlock = anthropicCreate.mock.calls[0][0].messages[0].content.find(
      (b: { type: string }) => b.type === "document",
    );
    expect(docBlock.source).toEqual({ type: "url", url: "https://example.com/resume.pdf" });
  });

  it("translates file_id documents to Anthropic's file source shape", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    await provider.complete({
      model: "claude-sonnet-4-6",
      messages: [userWithDoc(pdfDocFileId())],
    });

    const docBlock = anthropicCreate.mock.calls[0][0].messages[0].content.find(
      (b: { type: string }) => b.type === "document",
    );
    expect(docBlock.source).toEqual({ type: "file", file_id: "file_abc" });
  });
});

describe("Anthropic provider — cache surfacing", () => {
  it("surfaces cache_read_input_tokens and cache_creation_input_tokens", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 4096,
        cache_creation_input_tokens: 128,
      },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    const result = await provider.complete({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.usage?.cacheReadTokens).toBe(4096);
    expect(result.usage?.cacheCreationTokens).toBe(128);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("leaves cache fields undefined when the API doesn't report them", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    const result = await provider.complete({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.usage?.cacheReadTokens).toBeUndefined();
    expect(result.usage?.cacheCreationTokens).toBeUndefined();
  });
});

describe("Anthropic provider — cacheable system flag", () => {
  it("sends system as a string when cacheable is not set", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    await provider.complete({
      model: "claude-sonnet-4-6",
      system: "You are a parser.",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(anthropicCreate.mock.calls[0][0].system).toBe("You are a parser.");
  });

  it("wraps system in a cache_control block when cacheable is true", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    await provider.complete({
      model: "claude-sonnet-4-6",
      system: "You are a parser.",
      cacheable: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(anthropicCreate.mock.calls[0][0].system).toEqual([
      {
        type: "text",
        text: "You are a parser.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("does not attach cache_control when no system prompt is provided", async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const provider = createAnthropicProvider({ apiKey: "k" });
    await provider.complete({
      model: "claude-sonnet-4-6",
      cacheable: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(anthropicCreate.mock.calls[0][0].system).toBeUndefined();
  });
});

// ── OpenAI ──────────────────────────────────────────────────

describe("OpenAI provider — document blocks", () => {
  it("routes document requests through the Responses API with a data URL file part", async () => {
    openaiResponsesCreate.mockResolvedValue({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "summary" }],
        },
      ],
      output_text: "summary",
      status: "completed",
      usage: { input_tokens: 200, output_tokens: 30, total_tokens: 230 },
    });

    const provider = createOpenAIProvider({ apiKey: "k" });
    const req: CompletionRequest = {
      model: "gpt-4.1",
      system: "Extract fields from the resume.",
      messages: [userWithDoc(pdfDocBase64())],
    };
    const result = await provider.complete(req);

    expect(openaiChatCreate).not.toHaveBeenCalled();
    expect(openaiResponsesCreate).toHaveBeenCalledOnce();

    const call = openaiResponsesCreate.mock.calls[0][0];
    expect(call.model).toBe("gpt-4.1");

    // System hoisted to the first input item.
    expect(call.input[0]).toEqual({
      role: "system",
      content: [{ type: "input_text", text: "Extract fields from the resume." }],
    });

    // User content carries both the text and an input_file with a data URL.
    const userItem = call.input[1];
    expect(userItem.role).toBe("user");
    const filePart = userItem.content.find((c: { type: string }) => c.type === "input_file");
    expect(filePart).toEqual({
      type: "input_file",
      filename: "resume.pdf",
      file_data: "data:application/pdf;base64,JVBERi0xLjQK",
    });

    expect(result.text).toBe("summary");
  });

  it("uses file_url for url documents and file_id for file_id documents", async () => {
    openaiResponsesCreate.mockResolvedValue({
      output: [],
      output_text: "",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const provider = createOpenAIProvider({ apiKey: "k" });

    await provider.complete({
      model: "gpt-4o",
      messages: [userWithDoc(pdfDocUrl())],
    });
    const urlCall = openaiResponsesCreate.mock.calls[0][0];
    const urlPart = urlCall.input[0].content.find((c: { type: string }) => c.type === "input_file");
    expect(urlPart).toEqual({ type: "input_file", file_url: "https://example.com/resume.pdf" });

    openaiResponsesCreate.mockClear();

    await provider.complete({
      model: "gpt-4o",
      messages: [userWithDoc(pdfDocFileId())],
    });
    const idCall = openaiResponsesCreate.mock.calls[0][0];
    const idPart = idCall.input[0].content.find((c: { type: string }) => c.type === "input_file");
    expect(idPart).toEqual({ type: "input_file", file_id: "file_abc" });
  });

  it("throws a descriptive error when a non-Responses model is used with documents", async () => {
    const provider = createOpenAIProvider({ apiKey: "k" });
    await expect(
      provider.complete({
        model: "gpt-3.5-turbo",
        messages: [userWithDoc(pdfDocBase64())],
      }),
    ).rejects.toThrow(/does not support document inputs.*Responses API/);
    expect(openaiResponsesCreate).not.toHaveBeenCalled();
    expect(openaiChatCreate).not.toHaveBeenCalled();
  });

  it("does not touch the Responses API when no documents are present", async () => {
    openaiChatCreate.mockResolvedValue({
      choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const provider = createOpenAIProvider({ apiKey: "k" });
    await provider.complete({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(openaiResponsesCreate).not.toHaveBeenCalled();
    expect(openaiChatCreate).toHaveBeenCalledOnce();
  });
});

describe("OpenAI provider — cache surfacing", () => {
  it("surfaces prompt_tokens_details.cached_tokens from Chat Completions", async () => {
    openaiChatCreate.mockResolvedValue({
      choices: [{ message: { content: "hi", tool_calls: [] }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1024,
        completion_tokens: 10,
        total_tokens: 1034,
        prompt_tokens_details: { cached_tokens: 768 },
      },
    });

    const provider = createOpenAIProvider({ apiKey: "k" });
    const result = await provider.complete({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.usage?.cacheReadTokens).toBe(768);
    expect(result.usage?.cacheCreationTokens).toBeUndefined();
  });

  it("surfaces input_tokens_details.cached_tokens from the Responses API", async () => {
    openaiResponsesCreate.mockResolvedValue({
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
      output_text: "hi",
      status: "completed",
      usage: {
        input_tokens: 2048,
        output_tokens: 10,
        total_tokens: 2058,
        input_tokens_details: { cached_tokens: 1536 },
      },
    });

    const provider = createOpenAIProvider({ apiKey: "k" });
    const result = await provider.complete({
      model: "gpt-4.1",
      messages: [userWithDoc(pdfDocBase64())],
    });

    expect(result.usage?.cacheReadTokens).toBe(1536);
    expect(result.usage?.cacheCreationTokens).toBeUndefined();
  });
});
