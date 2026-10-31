import {
  classifyProviderError,
  describeProviderError,
  isRetryableKind,
  parseRetryAfterMs,
  providerErrorCode,
} from '@/lib/services/chat/providerErrors';

import { describe, expect, it } from 'vitest';

/**
 * The classifier is the single place that turns a provider/SDK failure into
 * a cause (`kind`). Everything downstream — in-turn retry, continuation,
 * the route's client code/message, the fallback-chain hint — keys on it, so
 * the shapes Azure/OpenAI/Anthropic actually emit must map correctly.
 */
describe('classifyProviderError', () => {
  it('maps a 429 to rate_limit with the Retry-After honoured', () => {
    const error = Object.assign(new Error('Too many requests'), {
      status: 429,
      headers: { 'retry-after': '7' },
    });
    const classified = classifyProviderError(error);
    expect(classified.kind).toBe('rate_limit');
    expect(classified.retryable).toBe(true);
    expect(classified.retryAfterMs).toBe(7_000);
    expect(classified.status).toBe(429);
  });

  it('maps 5xx to provider_internal (retryable) and other 4xx to invalid_request (not)', () => {
    expect(
      classifyProviderError(
        Object.assign(new Error('upstream'), { status: 503 }),
      ),
    ).toMatchObject({ kind: 'provider_internal', retryable: true });
    expect(
      classifyProviderError(
        Object.assign(new Error('bad body'), { status: 400 }),
      ),
    ).toMatchObject({ kind: 'invalid_request', retryable: false });
  });

  it('recognises Azure content-filter and context-overflow codes before status codes', () => {
    const filtered = Object.assign(new Error('filtered'), {
      status: 400,
      error: { code: 'content_filter', message: 'The response was filtered' },
    });
    expect(classifyProviderError(filtered)).toMatchObject({
      kind: 'content_filter',
      retryable: false,
    });

    const overflow = Object.assign(
      new Error(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      ),
      { status: 400, code: 'context_length_exceeded' },
    );
    expect(classifyProviderError(overflow)).toMatchObject({
      kind: 'context_overflow',
      retryable: false,
    });
  });

  it('agrees with config/models isDeploymentNotFoundError on both shapes', () => {
    expect(
      classifyProviderError({
        code: 'DeploymentNotFound',
        message: 'The API deployment for this resource does not exist.',
      }).kind,
    ).toBe('deployment_not_found');
    expect(
      classifyProviderError(
        Object.assign(new Error('deployment gpt-x not found'), {
          code: '404',
        }),
      ).kind,
    ).toBe('deployment_not_found');
  });

  it('treats connection failures as transport and SDK timeouts as timeout', () => {
    expect(
      classifyProviderError(
        Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }),
      ),
    ).toMatchObject({ kind: 'transport', retryable: true });
    const timeout = new Error('Request timed out.');
    timeout.name = 'APIConnectionTimeoutError';
    expect(classifyProviderError(timeout)).toMatchObject({
      kind: 'timeout',
      retryable: true,
    });
  });

  it('never retries an abort or a programming error, but retries the unknown', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(classifyProviderError(abort)).toMatchObject({
      kind: 'aborted',
      retryable: false,
    });
    expect(
      classifyProviderError(
        new TypeError('Cannot read properties of undefined'),
      ),
    ).toMatchObject({ kind: 'unknown', retryable: false });
    expect(classifyProviderError(new Error('something odd'))).toMatchObject({
      kind: 'unknown',
      retryable: true,
    });
  });

  it('lets an explicit x-should-retry header override the kind default', () => {
    const noRetry = Object.assign(new Error('boom'), {
      status: 500,
      headers: { 'x-should-retry': 'false' },
    });
    expect(classifyProviderError(noRetry).retryable).toBe(false);
    const doRetry = Object.assign(new Error('bad'), {
      status: 400,
      headers: { 'x-should-retry': 'true' },
    });
    expect(classifyProviderError(doRetry).retryable).toBe(true);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads ms, seconds and HTTP-date forms', () => {
    const now = Date.UTC(2026, 9, 30, 12, 0, 0);
    expect(parseRetryAfterMs({ 'retry-after-ms': '1500' }, now)).toBe(1500);
    expect(parseRetryAfterMs({ 'retry-after': '3' }, now)).toBe(3000);
    expect(
      parseRetryAfterMs(
        { 'retry-after': new Date(now + 10_000).toUTCString() },
        now,
      ),
    ).toBe(10_000);
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});

describe('client-facing mapping', () => {
  it('gives every kind a code and a sentence without provider wording', () => {
    const kinds = [
      'rate_limit',
      'provider_internal',
      'transport',
      'timeout',
      'auth',
      'quota',
      'content_filter',
      'context_overflow',
      'invalid_request',
      'deployment_not_found',
      'incomplete_stream',
      'aborted',
      'unknown',
    ] as const;
    for (const kind of kinds) {
      expect(providerErrorCode(kind)).toMatch(/^[A-Z_]+$/);
      expect(describeProviderError(kind).length).toBeGreaterThan(10);
    }
    expect(providerErrorCode('rate_limit')).toBe('MODEL_RATE_LIMITED');
    expect(providerErrorCode('context_overflow')).toBe(
      'MODEL_CONTEXT_TOO_LONG',
    );
    expect(providerErrorCode('content_filter')).toBe('MODEL_CONTENT_FILTERED');
    expect(isRetryableKind('content_filter')).toBe(false);
    expect(isRetryableKind('rate_limit')).toBe(true);
  });
});
