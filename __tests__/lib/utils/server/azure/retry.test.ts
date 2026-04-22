import {
  isTransientAzureError,
  withAzureRetry,
} from '@/lib/utils/server/azure/retry';

import { describe, expect, it, vi } from 'vitest';

describe('isTransientAzureError', () => {
  it('treats 5xx as transient', () => {
    expect(isTransientAzureError({ statusCode: 500 })).toBe(true);
    expect(isTransientAzureError({ statusCode: 503 })).toBe(true);
    expect(isTransientAzureError({ status: 502 })).toBe(true);
  });

  it('does not treat 4xx as transient', () => {
    expect(isTransientAzureError({ statusCode: 400 })).toBe(false);
    expect(isTransientAzureError({ statusCode: 401 })).toBe(false);
    expect(isTransientAzureError({ statusCode: 404 })).toBe(false);
    expect(isTransientAzureError({ statusCode: 429 })).toBe(false);
  });

  it('treats network error codes as transient', () => {
    expect(isTransientAzureError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientAzureError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientAzureError({ code: 'ENOTFOUND' })).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isTransientAzureError(new Error('boom'))).toBe(false);
    expect(isTransientAzureError(null)).toBe(false);
    expect(isTransientAzureError(undefined)).toBe(false);
  });
});

describe('withAzureRetry', () => {
  it('returns the result on success without retrying', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withAzureRetry(op);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on transient errors and eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 503 })
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValue('ok');
    const result = await withAzureRetry(op, { attempts: 3 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does not retry on non-transient 4xx', async () => {
    const err = { statusCode: 404, message: 'not found' };
    const op = vi.fn().mockRejectedValue(err);
    await expect(withAzureRetry(op, { attempts: 3 })).rejects.toMatchObject(
      err,
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting retries', async () => {
    const err = { statusCode: 503, message: 'bad gateway' };
    const op = vi.fn().mockRejectedValue(err);
    await expect(withAzureRetry(op, { attempts: 2 })).rejects.toMatchObject(
      err,
    );
    expect(op).toHaveBeenCalledTimes(2);
  });
});
