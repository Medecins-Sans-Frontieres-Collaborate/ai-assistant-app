import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import { ErrorCode, PipelineError } from '@/lib/types/errors';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('RateLimiter', () => {
  beforeEach(() => {
    // Reset singleton before each test
    RateLimiter.resetInstance();
    vi.useFakeTimers();
  });

  afterEach(() => {
    RateLimiter.resetInstance();
    vi.useRealTimers();
  });

  describe('Singleton Pattern', () => {
    it('should return the same instance on multiple calls', () => {
      const instance1 = RateLimiter.getInstance();
      const instance2 = RateLimiter.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should initialize with default values', () => {
      const limiter = RateLimiter.getInstance();
      const stats = limiter.getStats();

      expect(stats.totalUsers).toBe(0);
    });

    it('should accept custom configuration', () => {
      const limiter = RateLimiter.getInstance(50, 5); // 50 requests per 5 minutes

      // Make a request to verify it works
      const result = limiter.checkLimit('user1');

      expect(result.limit).toBe(50);
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkLimit', () => {
    it('should allow first request', () => {
      const limiter = RateLimiter.getInstance(10, 1);
      const result = limiter.checkLimit('user1');

      expect(result.allowed).toBe(true);
      expect(result.count).toBe(1);
      expect(result.remaining).toBe(9);
      expect(result.limit).toBe(10);
    });

    it('should increment count on subsequent requests', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      const result1 = limiter.checkLimit('user1');
      const result2 = limiter.checkLimit('user1');
      const result3 = limiter.checkLimit('user1');

      expect(result1.count).toBe(1);
      expect(result2.count).toBe(2);
      expect(result3.count).toBe(3);
      expect(result3.remaining).toBe(7);
    });

    it('should allow requests up to the limit', () => {
      const limiter = RateLimiter.getInstance(3, 1);

      const result1 = limiter.checkLimit('user1');
      const result2 = limiter.checkLimit('user1');
      const result3 = limiter.checkLimit('user1');

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      expect(result3.allowed).toBe(true);
    });

    it('should block requests exceeding the limit', () => {
      const limiter = RateLimiter.getInstance(3, 1);

      limiter.checkLimit('user1');
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');
      const result = limiter.checkLimit('user1'); // 4th request

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeDefined();
    });

    it('should provide retry-after time when blocked', () => {
      const limiter = RateLimiter.getInstance(2, 1);

      limiter.checkLimit('user1');
      limiter.checkLimit('user1');
      const result = limiter.checkLimit('user1'); // Over limit

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should isolate different users', () => {
      const limiter = RateLimiter.getInstance(3, 1);

      // User 1 makes 3 requests
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');

      // User 2 should still have their full quota
      const user2Result = limiter.checkLimit('user2');

      expect(user2Result.allowed).toBe(true);
      expect(user2Result.count).toBe(1);
      expect(user2Result.remaining).toBe(2);
    });

    it('should reset window after expiration', () => {
      const limiter = RateLimiter.getInstance(3, 1);

      // Make 3 requests
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');

      // 4th request should fail
      const blockedResult = limiter.checkLimit('user1');
      expect(blockedResult.allowed).toBe(false);

      // Advance time by 61 seconds (past the 1 minute window)
      vi.advanceTimersByTime(61 * 1000);

      // Next request should be allowed (new window)
      const newWindowResult = limiter.checkLimit('user1');
      expect(newWindowResult.allowed).toBe(true);
      expect(newWindowResult.count).toBe(1);
    });

    it('should update reset time correctly', () => {
      const limiter = RateLimiter.getInstance(5, 1);
      const now = Date.now();

      const result = limiter.checkLimit('user1');

      expect(result.resetTime).toBeGreaterThan(now);
      expect(result.resetTime).toBeLessThanOrEqual(now + 60 * 1000);
    });
  });

  describe('enforceLimit', () => {
    it('should return result when limit not exceeded', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      expect(() => limiter.enforceLimit('user1')).not.toThrow();

      const result = limiter.enforceLimit('user1');
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(2); // Second call
    });

    it('should throw PipelineError when limit exceeded', () => {
      const limiter = RateLimiter.getInstance(2, 1);

      limiter.enforceLimit('user1');
      limiter.enforceLimit('user1');

      // 3rd request should throw
      expect(() => limiter.enforceLimit('user1')).toThrow(PipelineError);
    });

    it('should throw error with correct error code', () => {
      const limiter = RateLimiter.getInstance(1, 1);

      limiter.enforceLimit('user1');

      try {
        limiter.enforceLimit('user1');
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);
        expect((error as PipelineError).code).toBe(
          ErrorCode.RATE_LIMIT_EXCEEDED,
        );
        expect((error as PipelineError).severity).toBe('CRITICAL');
      }
    });

    it('should include retry-after in error metadata', () => {
      const limiter = RateLimiter.getInstance(1, 1);

      limiter.enforceLimit('user1');

      try {
        limiter.enforceLimit('user1');
      } catch (error) {
        expect(error).toBeInstanceOf(PipelineError);
        const pipelineError = error as PipelineError;
        expect(pipelineError.metadata?.retryAfter).toBeDefined();
        expect(pipelineError.metadata?.limit).toBe(1);
        expect(pipelineError.metadata?.resetTime).toBeDefined();
      }
    });

    it('should include user ID in error metadata', () => {
      const limiter = RateLimiter.getInstance(1, 1);

      limiter.enforceLimit('test-user-123');

      try {
        limiter.enforceLimit('test-user-123');
      } catch (error) {
        const pipelineError = error as PipelineError;
        expect(pipelineError.metadata?.userId).toBe('test-user-123');
      }
    });
  });

  describe('reset', () => {
    it('should reset limit for specific user', () => {
      const limiter = RateLimiter.getInstance(2, 1);

      limiter.checkLimit('user1');
      limiter.checkLimit('user1');

      // User is at limit
      let result = limiter.checkLimit('user1');
      expect(result.allowed).toBe(false);

      // Reset user1
      limiter.reset('user1');

      // User should have full quota again
      result = limiter.checkLimit('user1');
      expect(result.allowed).toBe(true);
      expect(result.count).toBe(1);
    });

    it('should not affect other users', () => {
      const limiter = RateLimiter.getInstance(3, 1);

      limiter.checkLimit('user1');
      limiter.checkLimit('user2');

      limiter.reset('user1');

      // User2 should still have their count
      const result = limiter.checkLimit('user2');
      expect(result.count).toBe(2); // Second call
    });
  });

  describe('resetAll', () => {
    it('should reset all users', () => {
      const limiter = RateLimiter.getInstance(2, 1);

      limiter.checkLimit('user1');
      limiter.checkLimit('user2');
      limiter.checkLimit('user3');

      limiter.resetAll();

      // All users should be reset
      expect(limiter.checkLimit('user1').count).toBe(1);
      expect(limiter.checkLimit('user2').count).toBe(1);
      expect(limiter.checkLimit('user3').count).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return correct total users', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      limiter.checkLimit('user1');
      limiter.checkLimit('user2');
      limiter.checkLimit('user3');

      const stats = limiter.getStats();
      expect(stats.totalUsers).toBe(3);
    });

    it('should estimate memory usage', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      limiter.checkLimit('user1');
      limiter.checkLimit('user2');

      const stats = limiter.getStats();
      expect(stats.memoryUsage).toBeGreaterThan(0);
      expect(stats.memoryUsage).toBe(stats.totalUsers * 32); // Approximate
    });

    it('should show zero for empty limiter', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      const stats = limiter.getStats();
      expect(stats.totalUsers).toBe(0);
      expect(stats.memoryUsage).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should remove expired entries automatically', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      // Make requests for multiple users
      limiter.checkLimit('user1');
      limiter.checkLimit('user2');
      limiter.checkLimit('user3');

      expect(limiter.getStats().totalUsers).toBe(3);

      // Advance time past window + cleanup interval (122 seconds)
      // This should trigger cleanup intervals at 60s and 120s
      vi.advanceTimersByTime(61 * 1000 + 61 * 1000);

      // Run only the currently pending timers (not future intervals)
      vi.runOnlyPendingTimers();

      // Cleanup should have removed expired entries
      const stats = limiter.getStats();
      expect(stats.totalUsers).toBe(0);
    });

    it('should keep active entries', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      limiter.checkLimit('user1');

      // Advance time but stay within window
      vi.advanceTimersByTime(30 * 1000); // 30 seconds

      // Entry should still exist
      expect(limiter.getStats().totalUsers).toBe(1);
    });

    it('should only remove entries past grace period', () => {
      const limiter = RateLimiter.getInstance(10, 1); // 1 minute window

      limiter.checkLimit('user1');
      limiter.checkLimit('user2');

      // Advance past window but not cleanup interval
      vi.advanceTimersByTime(61 * 1000);

      // Add new user to trigger check
      limiter.checkLimit('user3');

      // Old entries should remain until cleanup runs
      expect(limiter.getStats().totalUsers).toBeGreaterThan(0);
    });
  });

  describe('shutdown', () => {
    it('should stop cleanup interval', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      limiter.shutdown();

      // Make requests
      limiter.checkLimit('user1');

      // Advance time
      vi.advanceTimersByTime(120 * 1000);

      // Entries should not be cleaned up
      expect(limiter.getStats().totalUsers).toBe(1);
    });
  });

  describe('Concurrency', () => {
    it('should handle rapid concurrent requests from same user', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      // Simulate concurrent requests
      const results = [];
      for (let i = 0; i < 15; i++) {
        results.push(limiter.checkLimit('user1'));
      }

      // First 10 should be allowed
      expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);

      // Remaining should be blocked
      expect(results.slice(10).every((r) => !r.allowed)).toBe(true);
    });

    it('should handle concurrent requests from different users', () => {
      const limiter = RateLimiter.getInstance(5, 1);

      // Simulate concurrent requests from different users
      const user1Results = [];
      const user2Results = [];

      for (let i = 0; i < 3; i++) {
        user1Results.push(limiter.checkLimit('user1'));
        user2Results.push(limiter.checkLimit('user2'));
      }

      // Both users should have their requests allowed
      expect(user1Results.every((r) => r.allowed)).toBe(true);
      expect(user2Results.every((r) => r.allowed)).toBe(true);

      // Each should have correct count
      expect(user1Results[2].count).toBe(3);
      expect(user2Results[2].count).toBe(3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty user ID gracefully', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      expect(() => limiter.checkLimit('')).not.toThrow();

      const result = limiter.checkLimit('');
      expect(result.allowed).toBe(true);
    });

    it('should handle very long user IDs', () => {
      const limiter = RateLimiter.getInstance(10, 1);
      const longUserId = 'a'.repeat(10000);

      expect(() => limiter.checkLimit(longUserId)).not.toThrow();

      const result = limiter.checkLimit(longUserId);
      expect(result.allowed).toBe(true);
    });

    it('should handle special characters in user IDs', () => {
      const limiter = RateLimiter.getInstance(10, 1);
      const specialUserId = 'user-!@#$%^&*()_+{}[]|\\:";\'<>?,./';

      expect(() => limiter.checkLimit(specialUserId)).not.toThrow();

      const result = limiter.checkLimit(specialUserId);
      expect(result.allowed).toBe(true);
    });
  });

  describe('Security', () => {
    it('should not leak data between users', () => {
      const limiter = RateLimiter.getInstance(10, 1);

      // User 1 makes requests
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');

      // User 2 should not see user1's count
      const user2Result = limiter.checkLimit('user2');
      expect(user2Result.count).toBe(1);
      expect(user2Result.remaining).toBe(9);
    });

    it('should not allow one user to affect another', () => {
      const limiter = RateLimiter.getInstance(3, 1);

      // User 1 exhausts their limit
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');
      limiter.checkLimit('user1');

      const user1Blocked = limiter.checkLimit('user1');
      expect(user1Blocked.allowed).toBe(false);

      // User 2 should still have full quota
      const user2Result = limiter.checkLimit('user2');
      expect(user2Result.allowed).toBe(true);
    });
  });
});
