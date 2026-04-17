import { describe, it, expect } from "vitest";
import { toReadableStream } from "../src/streams.js";
import type { StreamEvent, CompletionResponse } from "../src/types.js";

async function* makeEvents(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

const completeResponse: CompletionResponse = {
  text: "hello world",
  toolCalls: [],
  done: true,
  providerId: "fake",
  model: "fake-1",
};

const sampleEvents: StreamEvent[] = [
  { type: "text_delta", text: "hello " },
  { type: "text_delta", text: "world" },
  { type: "complete", response: completeResponse },
];

describe("toReadableStream", () => {
  it("defaults to NDJSON framing (one JSON object per line)", async () => {
    const stream = toReadableStream(makeEvents(sampleEvents));
    const text = await collect(stream);
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({ type: "text_delta", text: "hello " });
    const last = JSON.parse(lines[2]);
    expect(last.type).toBe("complete");
    expect(last.response.text).toBe("hello world");
  });

  it("serializes as Server-Sent Events when format is 'sse'", async () => {
    const stream = toReadableStream(makeEvents(sampleEvents), { format: "sse" });
    const text = await collect(stream);
    // Each event ends with a blank line.
    expect(text).toContain("event: text_delta\n");
    expect(text).toContain("event: complete\n");
    expect(text.split("\n\n").length).toBeGreaterThanOrEqual(3);
    // data: payloads must be valid JSON.
    const firstData = text.match(/data: (\{.*\})/)?.[1];
    expect(firstData).toBeTruthy();
    expect(() => JSON.parse(firstData!)).not.toThrow();
  });

  it("emits only text deltas in 'raw' format", async () => {
    const stream = toReadableStream(makeEvents(sampleEvents), { format: "raw" });
    const text = await collect(stream);
    expect(text).toBe("hello world");
  });

  it("encodes error events in sse format with event: error", async () => {
    const errEvent: StreamEvent = { type: "error", error: new Error("boom") };
    const stream = toReadableStream(makeEvents([errEvent]), { format: "sse" });
    const text = await collect(stream);
    expect(text).toContain("event: error\n");
    expect(text).toContain('"message":"boom"');
  });

  it("propagates generator errors to the stream consumer", async () => {
    async function* broken(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", text: "partial" };
      throw new Error("generator failed");
    }
    const stream = toReadableStream(broken());
    const reader = stream.getReader();
    await reader.read(); // consume the partial chunk
    await expect(reader.read()).rejects.toThrow(/generator failed/);
  });
});
