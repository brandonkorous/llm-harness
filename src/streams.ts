/**
 * Web Streams utilities — convert async generators to ReadableStream.
 *
 * Enables compatibility with Web Streams API consumers:
 * Next.js Route Handlers, Hono, Fetch API Response, Cloudflare Workers, etc.
 */

import type { StreamEvent, CompletionRequest } from "./types.js";

/**
 * Serialization format for stream events sent over a ReadableStream.
 * - "json": Each event is a JSON line (NDJSON). Default.
 * - "sse": Server-Sent Events format (data: ...\n\n).
 * - "raw": Only text deltas, as raw UTF-8 text (no framing).
 */
export type StreamFormat = "json" | "sse" | "raw";

export interface ReadableStreamOptions {
  /** Serialization format. Default: "json". */
  format?: StreamFormat;
}

/**
 * Convert an async generator of StreamEvents into a ReadableStream.
 *
 * Works with any async iterable — not coupled to the router.
 *
 * @example
 * ```typescript
 * const readable = toReadableStream(router.stream({ model: "gpt-4o", messages }));
 * return new Response(readable, { headers: { "Content-Type": "text/event-stream" } });
 * ```
 */
export function toReadableStream(
  generator: AsyncIterable<StreamEvent>,
  options?: ReadableStreamOptions,
): ReadableStream<Uint8Array> {
  const format = options?.format ?? "json";
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of generator) {
          const chunk = serializeEvent(event, format);
          if (chunk) {
            controller.enqueue(encoder.encode(chunk));
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** Serialize a single event based on format. */
function serializeEvent(event: StreamEvent, format: StreamFormat): string | null {
  switch (format) {
    case "raw":
      // Only emit text content
      if (event.type === "text_delta") return event.text;
      return null;

    case "sse":
      if (event.type === "error") {
        return `event: error\ndata: ${JSON.stringify({ message: event.error.message })}\n\n`;
      }
      return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

    case "json":
    default:
      return JSON.stringify(event) + "\n";
  }
}
