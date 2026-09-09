/**
 * The `metadata` a usage-limit 403 (`RATE_LIMIT_QUOTA_EXCEEDED`) carries,
 * as emitted by `throwIfDenied` in lib/services/chat/pipeline/Middleware.ts.
 *
 * `limitKey` is an internal catalog key and must never be rendered — the
 * client uses it only to pick copy and actions (which model, which feature,
 * which budget). `limit` is `false` for boolean gates and a number for
 * counters and ceilings.
 */
export interface LimitDenialMetadata {
  limitKey: string;
  limit: number | false;
  used?: number;
  /** ISO instant the counter window rolls over; absent for gates/ceilings. */
  resetAt?: string;
  /** Set when a model-qualified cell denied the request. */
  modelId?: string;
  /** Set when a model-family cell denied the request. */
  series?: string;
  /** The model the request was actually for (may differ from `modelId`). */
  requestModelId?: string;
}

/**
 * Custom error class for API errors.
 *
 * Provides structured error information from API responses.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly response?: any;

  constructor(
    message: string,
    status: number,
    statusText: string,
    response?: any,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.response = response;

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
  }

  /**
   * Checks if error is an authentication error (401/403).
   *
   * ⚠ Status alone is NOT sufficient to conclude "sign in again" — a rate
   * limit and a usage-limit denial are also 429/403. Use
   * {@link isRateLimitError} to exclude those before telling a user their
   * session expired; {@link getUserMessage} already does.
   */
  public isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /**
   * A rate-limit or admin usage-limit denial, identified by the server's
   * error CODE rather than its status.
   *
   * Code, not status, because the two cannot be told apart by number: an
   * app-level burst limit and a model's Azure TPM limit are both 429, and a
   * usage-limit denial shares 403 with a genuine authorization failure. The
   * code is the only thing that distinguishes them.
   */
  public isRateLimitError(): boolean {
    const code = this.response?.code;
    return (
      code === 'RATE_LIMIT_EXCEEDED' || code === 'RATE_LIMIT_QUOTA_EXCEEDED'
    );
  }

  /**
   * Structured denial details from an admin usage-limit 403, or null for
   * every other error — including a `RATE_LIMIT_QUOTA_EXCEEDED` whose body
   * lost its metadata, so callers can fall back to the server sentence.
   * Only the fields the client renders from are copied; anything else in
   * the body is ignored.
   */
  public get limitDenial(): LimitDenialMetadata | null {
    if (this.response?.code !== 'RATE_LIMIT_QUOTA_EXCEEDED') return null;
    const meta: unknown = this.response?.metadata;
    if (!meta || typeof meta !== 'object') return null;
    const m = meta as Record<string, unknown>;
    if (typeof m.limitKey !== 'string') return null;
    if (typeof m.limit !== 'number' && m.limit !== false) return null;
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' && v.length > 0 ? v : undefined;
    const denial: LimitDenialMetadata = {
      limitKey: m.limitKey,
      limit: m.limit,
    };
    if (typeof m.used === 'number') denial.used = m.used;
    const resetAt = str(m.resetAt);
    if (resetAt) denial.resetAt = resetAt;
    const modelId = str(m.modelId);
    if (modelId) denial.modelId = modelId;
    const series = str(m.series);
    if (series) denial.series = series;
    const requestModelId = str(m.requestModelId);
    if (requestModelId) denial.requestModelId = requestModelId;
    return denial;
  }

  /**
   * Checks if error is a client error (4xx).
   */
  public isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /**
   * Checks if error is a server error (5xx).
   */
  public isServerError(): boolean {
    return this.status >= 500;
  }

  /**
   * Detects server-side validation failures whose path points into the
   * `messages[N]` array — these indicate a corrupted message record in the
   * current conversation's history (e.g., legacy `content` shape that the
   * server Zod schema rejects) rather than a problem with what the user
   * just typed.
   */
  public isCorruptedHistoryError(): boolean {
    if (this.status !== 400) return false;
    return /validation failed:\s*messages\.\d+\./i.test(this.message);
  }

  /**
   * Returns a user-friendly error message.
   */
  public getUserMessage(): string {
    // BEFORE the auth check: a rate limit (429) and a usage-limit denial
    // (403) would otherwise be rendered as "Please sign in", which is both
    // wrong and unactionable — and it would discard the server's message,
    // which is the only place the wait time or the limit that was hit is
    // stated.
    if (this.isRateLimitError()) {
      return this.message || 'Usage limit reached. Please try again later.';
    }

    // Session-death 401s (failed token refresh — e.g. after a client-secret
    // rotation) normally never render: chatStore forces a sign-out instead.
    // This copy is a fallback for other ApiError consumers.
    if (this.response?.code === 'AUTH_SESSION_EXPIRED') {
      return 'Your session has expired. Please sign in again to continue.';
    }

    if (this.isAuthError()) {
      return 'Authentication required. Please sign in.';
    }

    if (this.isServerError()) {
      return 'Server error. Please try again later.';
    }

    if (this.isCorruptedHistoryError()) {
      return (
        "This conversation's history couldn't be validated and the message " +
        'could not be sent. Please start a new conversation to continue.'
      );
    }

    return this.message || 'An error occurred. Please try again.';
  }
}
