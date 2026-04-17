import { describe, it, expect, vi } from "vitest";
import {
  isRetryable,
  backoffDelay,
  parseRetryAfter,
  withRetry,
  CircuitBreaker,
} from "../src/retry.js";

describe("isRetryable", () => {
  it("returns true for default retryable HTTP statuses", () => {
    for (const status of [429, 500, 502, 503, 529]) {
      expect(isRetryable({ status })).toBe(true);
    }
  });

  it("returns false for non-retryable HTTP statuses", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryable({ status })).toBe(false);
    }
  });

  it("returns true for transient network codes", () => {
    expect(isRetryable({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryable({ code: "ETIMEDOUT" })).toBe(true);
    expect(isRetryable({ code: "ENOTFOUND" })).toBe(true);
  });

  it("returns false for unknown error codes", () => {
    expect(isRetryable({ code: "EUNKNOWN" })).toBe(false);
  });

  it("returns false for non-object errors", () => {
    expect(isRetryable("boom")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });

  it("honors custom retryableStatuses", () => {
    expect(isRetryable({ status: 418 }, { retryableStatuses: [418] })).toBe(true);
    expect(isRetryable({ status: 500 }, { retryableStatuses: [418] })).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially from the base delay", () => {
    const d0 = backoffDelay(0, { baseDelay: 100, maxDelay: 10_000 });
    const d2 = backoffDelay(2, { baseDelay: 100, maxDelay: 10_000 });
    expect(d0).toBeGreaterThanOrEqual(100);
    expect(d2).toBeGreaterThanOrEqual(400);
  });

  it("caps at maxDelay", () => {
    const delay = backoffDelay(20, { baseDelay: 1000, maxDelay: 5000 });
    expect(delay).toBeLessThanOrEqual(5000);
  });
});

describe("parseRetryAfter", () => {
  it("parses integer seconds into ms", () => {
    expect(parseRetryAfter({ headers: { "retry-after": "3" } })).toBe(3000);
  });

  it("parses HTTP date strings into ms delta", () => {
    const future = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfter({ headers: { "retry-after": future } });
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it("returns null when header is missing or error is malformed", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter({})).toBeNull();
    expect(parseRetryAfter({ headers: {} })).toBeNull();
  });
});

describe("withRetry", () => {
  it("returns the value on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable errors and eventually succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw { status: 503 };
      return "ok";
    });
    const result = await withRetry(fn, { baseDelay: 1, maxDelay: 5 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on non-retryable errors", async () => {
    const err = { status: 400, message: "bad" };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { baseDelay: 1 })).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting maxRetries", async () => {
    const err = { status: 500 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelay: 1, maxDelay: 5 }),
    ).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe("CircuitBreaker", () => {
  it("reports providers as healthy by default", () => {
    const cb = new CircuitBreaker();
    expect(cb.isHealthy("openai")).toBe(true);
  });

  it("trips after threshold failures", () => {
    const cb = new CircuitBreaker(3, 60_000);
    cb.recordFailure("openai");
    cb.recordFailure("openai");
    expect(cb.isHealthy("openai")).toBe(true);
    cb.recordFailure("openai");
    expect(cb.isHealthy("openai")).toBe(false);
  });

  it("isolates state between providers", () => {
    const cb = new CircuitBreaker(2, 60_000);
    cb.recordFailure("openai");
    cb.recordFailure("openai");
    expect(cb.isHealthy("openai")).toBe(false);
    expect(cb.isHealthy("anthropic")).toBe(true);
  });

  it("recordSuccess resets failures", () => {
    const cb = new CircuitBreaker(2, 60_000);
    cb.recordFailure("openai");
    cb.recordFailure("openai");
    expect(cb.isHealthy("openai")).toBe(false);
    cb.recordSuccess("openai");
    expect(cb.isHealthy("openai")).toBe(true);
  });

  it("auto-resets after the cooldown window", () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker(1, 1000);
      cb.recordFailure("openai");
      expect(cb.isHealthy("openai")).toBe(false);
      vi.advanceTimersByTime(1500);
      expect(cb.isHealthy("openai")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
