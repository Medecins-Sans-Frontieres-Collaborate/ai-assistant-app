import {
  ClassifiedProviderError,
  classifyProviderError,
} from './providerErrors';

/**
 * In-turn retry of a model call.
 *
 * Why this exists: before 2026-10-31 a 429 or 503 from Foundry ended the
 * turn with an error card after the SDK's two silent pre-header retries.
 * Rate limits and overloads are the most common failure the app sees, and
 * almost all of them clear within seconds. The policy here retries the
 * create call (and, through the stream processors, a stream that died
 * before any output) with exponential backoff, honours Retry-After, and
 * reports every wait to the user as an activity marker so the loader
 * says "retrying" instead of freezing.
 *
 * Sized for a web chat, not a batch job: the user is watching, and the
 * pipeline's model-start timer (default 90 s) is still running. So the
 * defaults are 3 retries, 1 s → 8 s gaps (±25 % jitter), at most 30 s of
 * total waiting, and a Retry-After above 20 s is treated as "not now"
 * rather than slept through.
 */

export interface RetryPolicyOptions {
  /** Total attempts INCLUDING the first. Default 4 (= 3 retries). */
  maxAttempts?: number;
  /** First gap. Default 1000 ms. */
  baseDelayMs?: number;
  /** Per-gap ceiling. Default 8000 ms. */
  maxDelayMs?: number;
  /** A provider Retry-After above this is honoured as "give up". Default 20 s. */
  maxRetryAfterMs?: number;
  /** Ceiling on the SUM of all waits. Default 30 s. */
  maxTotalDelayMs?: number;
  /** Jitter source in [0, 1). Default Math.random (tests pass a constant). */
  random?: () => number;
}

export type RetryDecision =
  | {
      retry: true;
      attempt: number;
      delayMs: number;
      error: ClassifiedProviderError;
    }
  | {
      retry: false;
      reason:
        | 'not_retryable'
        | 'attempts_exhausted'
        | 'retry_after_too_long'
        | 'delay_budget_exhausted';
      error: ClassifiedProviderError;
    };

export interface RetryPolicy {
  /** Decide what to do after a failed attempt. `attempt` counts from 1. */
  decide(error: unknown): RetryDecision;
  /** Attempts made so far (the number of `decide` calls + 1). */
  readonly attempts: number;
}

const DEFAULTS: Required<RetryPolicyOptions> = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 20_000,
  maxTotalDelayMs: 30_000,
  random: Math.random,
};

export function createRetryPolicy(
  options: RetryPolicyOptions = {},
): RetryPolicy {
  const config = { ...DEFAULTS, ...options };
  let attempts = 1;
  let totalDelay = 0;
  return {
    get attempts() {
      return attempts;
    },
    decide(raw: unknown): RetryDecision {
      const error = classifyProviderError(raw);
      if (!error.retryable)
        return { retry: false, reason: 'not_retryable', error };
      if (attempts >= config.maxAttempts)
        return { retry: false, reason: 'attempts_exhausted', error };
      // Exponential with ±25 % jitter, capped per gap.
      const exponent = attempts - 1;
      const base = Math.min(
        config.baseDelayMs * 2 ** exponent,
        config.maxDelayMs,
      );
      const jitter = 0.75 + config.random() * 0.5;
      let delayMs = Math.ceil(base * jitter);
      if (error.retryAfterMs !== undefined) {
        if (error.retryAfterMs > config.maxRetryAfterMs)
          return { retry: false, reason: 'retry_after_too_long', error };
        delayMs = Math.max(delayMs, error.retryAfterMs);
      }
      if (totalDelay + delayMs > config.maxTotalDelayMs)
        return { retry: false, reason: 'delay_budget_exhausted', error };
      totalDelay += delayMs;
      attempts += 1;
      return { retry: true, attempt: attempts, delayMs, error };
    },
  };
}

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function sleepWithSignal(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Activity key the loader shows while a retry wait is in progress. */
export const MODEL_RETRY_ACTIVITY_KEY = 'chat.activity.retryingModel';

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  error: ClassifiedProviderError;
}

export interface WithModelRetryOptions {
  signal?: AbortSignal;
  policy?: RetryPolicy;
  /** Called BEFORE each wait — emit the "retrying" activity here. */
  onRetry?: (notice: RetryNotice) => void;
  /** Called when a retryable failure is NOT retried (policy said stop). */
  onGiveUp?: (decision: Extract<RetryDecision, { retry: false }>) => void;
}

/**
 * Run `attempt` until it succeeds or the policy stops retrying. Aborts
 * (stage timeout, client gone) are never retried and interrupt a wait.
 */
export async function withModelRetry<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: WithModelRetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? createRetryPolicy();
  for (;;) {
    const attemptNumber = policy.attempts;
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const decision = policy.decide(error);
      if (!decision.retry) {
        if (decision.reason !== 'not_retryable') options.onGiveUp?.(decision);
        throw error;
      }
      options.onRetry?.({
        attempt: decision.attempt,
        delayMs: decision.delayMs,
        error: decision.error,
      });
      await sleepWithSignal(decision.delayMs, options.signal);
    }
  }
}

/** Params for the "retrying" activity marker: whole seconds, attempt number. */
export function retryActivityParams(
  notice: RetryNotice,
): Record<string, string> {
  return {
    seconds: String(Math.max(1, Math.round(notice.delayMs / 1000))),
    attempt: String(notice.attempt),
  };
}
