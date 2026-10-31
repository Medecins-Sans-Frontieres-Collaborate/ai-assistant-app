import {
  createRetryPolicy,
  retryActivityParams,
  withModelRetry,
} from '@/lib/services/chat/modelRetry';

import { describe, expect, it, vi } from 'vitest';

const rateLimited = (retryAfter?: string) =>
  Object.assign(new Error('429'), {
    status: 429,
    headers: retryAfter ? { 'retry-after': retryAfter } : {},
  });

describe('createRetryPolicy', () => {
  it('backs off exponentially with jitter and stops at maxAttempts', () => {
    const policy = createRetryPolicy({
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      random: () => 0.5, // jitter factor exactly 1.0
    });
    const first = policy.decide(rateLimited());
    expect(first).toMatchObject({ retry: true, attempt: 2, delayMs: 1000 });
    const second = policy.decide(rateLimited());
    expect(second).toMatchObject({ retry: true, attempt: 3, delayMs: 2000 });
    const third = policy.decide(rateLimited());
    expect(third).toMatchObject({ retry: false, reason: 'attempts_exhausted' });
  });

  it('honours a short Retry-After and gives up on a long one', () => {
    const policy = createRetryPolicy({ random: () => 0.5 });
    expect(policy.decide(rateLimited('5'))).toMatchObject({
      retry: true,
      delayMs: 5000,
    });
    const fresh = createRetryPolicy({ random: () => 0.5 });
    expect(fresh.decide(rateLimited('120'))).toMatchObject({
      retry: false,
      reason: 'retry_after_too_long',
    });
  });

  it('never retries a non-retryable cause', () => {
    const policy = createRetryPolicy();
    expect(
      policy.decide(Object.assign(new Error('nope'), { status: 400 })),
    ).toMatchObject({ retry: false, reason: 'not_retryable' });
  });

  it('respects the total delay budget', () => {
    const policy = createRetryPolicy({
      maxAttempts: 10,
      baseDelayMs: 1000,
      maxDelayMs: 1000,
      maxTotalDelayMs: 2500,
      random: () => 0.5,
    });
    expect(policy.decide(rateLimited()).retry).toBe(true); // 1000
    expect(policy.decide(rateLimited()).retry).toBe(true); // 2000
    expect(policy.decide(rateLimited())).toMatchObject({
      retry: false,
      reason: 'delay_budget_exhausted',
    });
  });
});

describe('withModelRetry', () => {
  it('retries retryable failures, announcing each wait, then succeeds', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await withModelRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw rateLimited();
        return 'ok';
      },
      {
        policy: createRetryPolicy({ baseDelayMs: 0, maxDelayMs: 0 }),
        onRetry,
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatchObject({
      attempt: 2,
      error: { kind: 'rate_limit' },
    });
  });

  it('rethrows immediately on a non-retryable failure and reports give-ups', async () => {
    const onGiveUp = vi.fn();
    const onRetry = vi.fn();
    let calls = 0;
    await expect(
      withModelRetry(
        async () => {
          calls += 1;
          throw Object.assign(new Error('bad request'), { status: 400 });
        },
        { onRetry, onGiveUp },
      ),
    ).rejects.toThrow('bad request');
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
    // not_retryable is not a "give up": nothing was ever going to be retried.
    expect(onGiveUp).not.toHaveBeenCalled();

    const exhausted = vi.fn();
    await expect(
      withModelRetry(
        async () => {
          throw rateLimited();
        },
        {
          policy: createRetryPolicy({
            maxAttempts: 2,
            baseDelayMs: 0,
            maxDelayMs: 0,
          }),
          onGiveUp: exhausted,
        },
      ),
    ).rejects.toThrow('429');
    expect(exhausted).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'attempts_exhausted' }),
    );
  });

  it('does not retry once the request signal is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withModelRetry(
        async () => {
          calls += 1;
          controller.abort();
          throw rateLimited();
        },
        {
          signal: controller.signal,
          policy: createRetryPolicy({ baseDelayMs: 0, maxDelayMs: 0 }),
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('formats loader params in whole seconds', () => {
    expect(
      retryActivityParams({
        attempt: 2,
        delayMs: 2400,
        error: { kind: 'rate_limit', retryable: true, message: '' },
      }),
    ).toEqual({ seconds: '2', attempt: '2' });
  });
});
