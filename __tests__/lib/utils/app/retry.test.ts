import { retryAsync, retryWithExponentialBackoff } from '@/lib/utils/app/retry';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Retry Utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('retryWithExponentialBackoff', () => {
    it('should return result on first successful attempt', async () => {
      const mockFn = vi.fn().mockResolvedValue('success');

      const promise = retryWithExponentialBackoff(mockFn);
      const result = await promise;

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryWithExponentialBackoff(mockFn);

      // Fast-forward timers for retry delays
      await vi.advanceTimersByTimeAsync(1000); // First retry after 1s
      await vi.advanceTimersByTimeAsync(2000); // Second retry after 2s

      const result = await promise;

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(3);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Attempt 1 failed. Retrying in 1000ms...',
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Attempt 2 failed. Retrying in 2000ms...',
      );

      consoleWarnSpy.mockRestore();
    });

    it('should throw error after max retries', async () => {
      const error = new Error('Persistent failure');
      const mockFn = vi.fn().mockRejectedValue(error);

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryWithExponentialBackoff(mockFn, 2); // Max 2 retries

      // Fast-forward timers and await rejections
      const advanceAndCatch = async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(4000);
      };

      await Promise.all([promise.catch(() => {}), advanceAndCatch()]);

      await expect(promise).rejects.toThrow('Persistent failure');
      expect(mockFn).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(consoleWarnSpy).toHaveBeenCalledTimes(2);

      consoleWarnSpy.mockRestore();
    });

    it('should use exponential backoff with custom base delay', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryWithExponentialBackoff(mockFn, 3, 500); // Base delay 500ms

      await vi.advanceTimersByTimeAsync(500); // 2^0 * 500 = 500ms
      await vi.advanceTimersByTimeAsync(1000); // 2^1 * 500 = 1000ms

      const result = await promise;

      expect(result).toBe('success');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Attempt 1 failed. Retrying in 500ms...',
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Attempt 2 failed. Retrying in 1000ms...',
      );

      consoleWarnSpy.mockRestore();
    });

    it('should cap delay at 10 seconds', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockRejectedValueOnce(new Error('Fail 3'))
        .mockRejectedValueOnce(new Error('Fail 4'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryWithExponentialBackoff(mockFn, 5, 5000); // Base delay 5s

      await vi.advanceTimersByTimeAsync(5000); // 2^0 * 5000 = 5000ms
      await vi.advanceTimersByTimeAsync(10000); // 2^1 * 5000 = 10000ms (capped at 10s)
      await vi.advanceTimersByTimeAsync(10000); // 2^2 * 5000 = 20000ms (capped at 10s)
      await vi.advanceTimersByTimeAsync(10000); // 2^3 * 5000 = 40000ms (capped at 10s)

      const result = await promise;

      expect(result).toBe('success');
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Attempt 3 failed. Retrying in 10000ms...',
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Attempt 4 failed. Retrying in 10000ms...',
      );

      consoleWarnSpy.mockRestore();
    });

    it('should handle async functions that return values', async () => {
      const mockFn = vi.fn().mockResolvedValue({ data: 'test', code: 200 });

      const result = await retryWithExponentialBackoff(mockFn);

      expect(result).toEqual({ data: 'test', code: 200 });
    });
  });

  describe('retryAsync', () => {
    it('should return result on first successful attempt', async () => {
      const mockOperation = vi.fn().mockResolvedValue('success');

      const result = await retryAsync(mockOperation);

      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryAsync(mockOperation);

      await vi.advanceTimersByTimeAsync(1000); // First retry after 1s

      const result = await promise;

      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(2);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Attempt 1 failed. Retrying in 1000ms...',
      );

      consoleWarnSpy.mockRestore();
    });

    it('should throw error after max retries', async () => {
      const error = new Error('Persistent failure');
      const mockOperation = vi.fn().mockRejectedValue(error);

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryAsync(mockOperation, 1); // Max 1 retry

      const advanceAndCatch = async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
      };

      await Promise.all([promise.catch(() => {}), advanceAndCatch()]);

      await expect(promise).rejects.toThrow('Persistent failure');
      expect(mockOperation).toHaveBeenCalledTimes(2); // Initial + 1 retry

      consoleWarnSpy.mockRestore();
    });

    it('should use exponential backoff with custom delays', async () => {
      const mockOperation = vi
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue('success');

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryAsync(mockOperation, 2, 2000); // 2 retries, 2s base delay

      await vi.advanceTimersByTimeAsync(2000); // 2^0 * 2000 = 2000ms
      await vi.advanceTimersByTimeAsync(4000); // 2^1 * 2000 = 4000ms

      const result = await promise;

      expect(result).toBe('success');
      expect(mockOperation).toHaveBeenCalledTimes(3);

      consoleWarnSpy.mockRestore();
    });

    it('should handle operations that return different types', async () => {
      const mockOperation = vi.fn().mockResolvedValue(Buffer.from('test'));

      const result = await retryAsync(mockOperation);

      expect(result).toBeInstanceOf(Buffer);
      expect((result as Buffer).toString()).toBe('test');
    });

    it('should preserve error details when retries exhausted', async () => {
      const customError = new Error('Custom error message');
      (customError as any).code = 'CUSTOM_CODE';
      const mockOperation = vi.fn().mockRejectedValue(customError);

      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const promise = retryAsync(mockOperation, 0); // No retries

      await expect(promise).rejects.toThrow('Custom error message');
      await expect(promise).rejects.toMatchObject({ code: 'CUSTOM_CODE' });

      consoleWarnSpy.mockRestore();
    });
  });

  describe('Edge cases', () => {
    it('retryWithExponentialBackoff should handle zero retries', async () => {
      const mockFn = vi.fn().mockRejectedValue(new Error('Immediate failure'));

      await expect(retryWithExponentialBackoff(mockFn, 0)).rejects.toThrow(
        'Immediate failure',
      );
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('retryAsync should handle zero retries', async () => {
      const mockOperation = vi
        .fn()
        .mockRejectedValue(new Error('Immediate failure'));

      await expect(retryAsync(mockOperation, 0)).rejects.toThrow(
        'Immediate failure',
      );
      expect(mockOperation).toHaveBeenCalledTimes(1);
    });

    it('should handle promise rejection with non-Error values', async () => {
      const mockFn = vi.fn().mockRejectedValue('String error');

      await expect(retryWithExponentialBackoff(mockFn, 0)).rejects.toBe(
        'String error',
      );
    });
  });
});
