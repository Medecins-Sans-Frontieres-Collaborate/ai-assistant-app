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
   */
  public isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
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
   * Returns a user-friendly error message.
   */
  public getUserMessage(): string {
    if (this.isAuthError()) {
      return 'Authentication required. Please sign in.';
    }

    if (this.isServerError()) {
      return 'Server error. Please try again later.';
    }

    return this.message || 'An error occurred. Please try again.';
  }
}
