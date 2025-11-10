import { ErrorCode, PipelineError } from '@/lib/types/errors';

/**
 * Rate limit information for a user.
 */
interface RateLimitInfo {
  /** Number of requests made in current window */
  count: number;

  /** Timestamp when the current window started */
  windowStart: number;

  /** Timestamp when the window resets */
  resetTime: number;
}

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;

  /** Current request count in window */
  count: number;

  /** Maximum requests allowed per window */
  limit: number;

  /** Remaining requests in current window */
  remaining: number;

  /** Timestamp when the limit resets (ms since epoch) */
  resetTime: number;

  /** Time until reset in milliseconds */
  retryAfter?: number;
}

/**
 * Simple in-memory rate limiter using sliding window algorithm.
 *
 * Security features:
 * - Per-user rate limiting (isolated by user ID)
 * - No data leakage between users
 * - Automatic cleanup of old entries
 * - Configurable limits
 *
 * Limitations:
 * - In-memory only (resets on server restart)
 * - Not distributed (single instance only)
 * - For production with multiple instances, use Redis-based solution
 *
 * Usage:
 * ```typescript
 * const limiter = RateLimiter.getInstance();
 * const result = limiter.checkLimit(userId);
 * if (!result.allowed) {
 *   throw new Error('Rate limit exceeded');
 * }
 * ```
 */
export class RateLimiter {
  private static instance: RateLimiter | null = null;

  /** Map of userId -> rate limit info */
  private limits: Map<string, RateLimitInfo> = new Map();

  /** Number of requests allowed per window */
  private readonly requestsPerWindow: number;

  /** Window size in milliseconds */
  private readonly windowMs: number;

  /** Interval for cleaning up old entries (ms) */
  private readonly cleanupIntervalMs: number = 60000; // 1 minute

  private cleanupInterval: NodeJS.Timeout | null = null;

  private constructor(
    requestsPerWindow: number = 100,
    windowMinutes: number = 1,
  ) {
    this.requestsPerWindow = requestsPerWindow;
    this.windowMs = windowMinutes * 60 * 1000;

    // Start cleanup interval
    this.startCleanup();

    console.log(
      `[RateLimiter] Initialized: ${requestsPerWindow} requests per ${windowMinutes} minute(s)`,
    );
  }

  /**
   * Gets the singleton instance of RateLimiter.
   *
   * @param requestsPerWindow - Max requests per window (default: 100)
   * @param windowMinutes - Window size in minutes (default: 1)
   */
  public static getInstance(
    requestsPerWindow: number = 100,
    windowMinutes: number = 1,
  ): RateLimiter {
    if (!RateLimiter.instance) {
      RateLimiter.instance = new RateLimiter(requestsPerWindow, windowMinutes);
    }
    return RateLimiter.instance;
  }

  /**
   * Checks if a user has exceeded their rate limit.
   *
   * @param userId - Unique user identifier
   * @returns Rate limit result
   */
  public checkLimit(userId: string): RateLimitResult {
    const now = Date.now();
    let info = this.limits.get(userId);

    // If no info exists or window has expired, create new window
    if (!info || now >= info.resetTime) {
      info = {
        count: 1,
        windowStart: now,
        resetTime: now + this.windowMs,
      };
      this.limits.set(userId, info);

      return {
        allowed: true,
        count: 1,
        limit: this.requestsPerWindow,
        remaining: this.requestsPerWindow - 1,
        resetTime: info.resetTime,
      };
    }

    // Increment count
    info.count++;

    const allowed = info.count <= this.requestsPerWindow;
    const remaining = Math.max(0, this.requestsPerWindow - info.count);

    return {
      allowed,
      count: info.count,
      limit: this.requestsPerWindow,
      remaining,
      resetTime: info.resetTime,
      retryAfter: allowed ? undefined : info.resetTime - now,
    };
  }

  /**
   * Enforces rate limit and throws an error if exceeded.
   *
   * @param userId - Unique user identifier
   * @throws PipelineError if rate limit exceeded
   */
  public enforceLimit(userId: string): RateLimitResult {
    const result = this.checkLimit(userId);

    if (!result.allowed) {
      throw PipelineError.critical(
        ErrorCode.RATE_LIMIT_EXCEEDED,
        `Rate limit exceeded. Try again in ${Math.ceil((result.retryAfter || 0) / 1000)} seconds.`,
        {
          userId,
          limit: result.limit,
          resetTime: result.resetTime,
          retryAfter: result.retryAfter,
        },
      );
    }

    return result;
  }

  /**
   * Resets rate limit for a specific user.
   * Only use for testing or admin operations.
   *
   * @param userId - User to reset
   */
  public reset(userId: string): void {
    this.limits.delete(userId);
  }

  /**
   * Resets all rate limits.
   * Only use for testing.
   */
  public resetAll(): void {
    this.limits.clear();
  }

  /**
   * Gets current statistics.
   */
  public getStats(): {
    totalUsers: number;
    memoryUsage: number;
  } {
    return {
      totalUsers: this.limits.size,
      memoryUsage: this.limits.size * 32, // Approximate bytes
    };
  }

  /**
   * Starts periodic cleanup of expired entries.
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
  }

  /**
   * Removes expired entries from the map.
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [userId, info] of this.limits.entries()) {
      // Remove if window has expired and some time has passed
      if (now > info.resetTime + this.windowMs) {
        this.limits.delete(userId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(
        `[RateLimiter] Cleanup: removed ${removed} expired entries. Active users: ${this.limits.size}`,
      );
    }
  }

  /**
   * Stops cleanup interval.
   * Call this when shutting down the application.
   */
  public shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    console.log('[RateLimiter] Shutdown complete');
  }

  /**
   * Resets the singleton instance.
   * Only use for testing.
   */
  public static resetInstance(): void {
    if (RateLimiter.instance) {
      RateLimiter.instance.shutdown();
      RateLimiter.instance = null;
    }
  }
}
