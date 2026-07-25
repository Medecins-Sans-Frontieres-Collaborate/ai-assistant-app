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
