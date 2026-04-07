/**
 * Retry and circuit breaker utilities.
 *
 * Implements exponential backoff with jitter, respects Retry-After headers,
 * and provides a lightweight circuit breaker for failover scenarios.
 */

import type { RetryConfig, ProviderId } from "./types.js";

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
  retryableStatuses: [429, 500, 502, 503, 529],
};

/** Determine if an error is retryable. */
export function isRetryable(
  error: unknown,
  config: RetryConfig = {},
): boolean {
  const statuses = config.retryableStatuses ?? DEFAULT_RETRY.retryableStatuses;

  if (error && typeof error === "object") {
    const status = (error as { status?: number }).status;
    if (status && statuses.includes(status)) return true;

    const code = (error as { code?: string }).code;
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
      return true;
    }
  }

  return false;
}

/** Calculate delay with exponential backoff + jitter. */
export function backoffDelay(
  attempt: number,
  config: RetryConfig = {},
): number {
  const base = config.baseDelay ?? DEFAULT_RETRY.baseDelay;
  const max = config.maxDelay ?? DEFAULT_RETRY.maxDelay;
  const exponential = base * 2 ** attempt;
  const jitter = Math.random() * base;
  return Math.min(exponential + jitter, max);
}

/** Extract Retry-After header value in ms, if present. */
export function parseRetryAfter(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;

  const headers = (error as { headers?: Record<string, string> }).headers;
  const retryAfter = headers?.["retry-after"];
  if (!retryAfter) return null;

  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) return seconds * 1000;

  const date = Date.parse(retryAfter);
  if (!isNaN(date)) return Math.max(0, date - Date.now());

  return null;
}

/**
 * Execute an async function with retry logic.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = {},
): Promise<T> {
  const maxRetries = config.maxRetries ?? DEFAULT_RETRY.maxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error, config)) {
        throw error;
      }

      const retryAfter = parseRetryAfter(error);
      const delay = retryAfter ?? backoffDelay(attempt, config);
      await sleep(delay);
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error("Retry exhausted");
}

// ── Circuit Breaker ──────────────────────────────────────────

interface CircuitState {
  failures: number;
  lastFailure: number;
  open: boolean;
}

export class CircuitBreaker {
  private circuits = new Map<ProviderId, CircuitState>();
  private threshold: number;
  private resetMs: number;

  constructor(threshold = 5, resetMs = 60000) {
    this.threshold = threshold;
    this.resetMs = resetMs;
  }

  /** Record a successful call — resets the circuit. */
  recordSuccess(providerId: ProviderId): void {
    this.circuits.delete(providerId);
  }

  /** Record a failure — may trip the circuit. */
  recordFailure(providerId: ProviderId): void {
    const state = this.circuits.get(providerId) ?? {
      failures: 0,
      lastFailure: 0,
      open: false,
    };

    state.failures++;
    state.lastFailure = Date.now();
    state.open = state.failures >= this.threshold;
    this.circuits.set(providerId, state);
  }

  /** Check if a provider is healthy (circuit closed or reset timeout elapsed). */
  isHealthy(providerId: ProviderId): boolean {
    const state = this.circuits.get(providerId);
    if (!state || !state.open) return true;

    // Auto-reset after timeout (half-open → allow one attempt)
    if (Date.now() - state.lastFailure > this.resetMs) {
      state.open = false;
      state.failures = 0;
      return true;
    }

    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
