import { ApiError } from '@/client/services/api/errors';

import { describe, expect, it } from 'vitest';

describe('ApiError', () => {
  describe('constructor', () => {
    it('should create an error with all properties', () => {
      const error = new ApiError('Not found', 404, 'Not Found', {
        details: 'Resource not found',
      });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error.name).toBe('ApiError');
      expect(error.message).toBe('Not found');
      expect(error.status).toBe(404);
      expect(error.statusText).toBe('Not Found');
      expect(error.response).toEqual({ details: 'Resource not found' });
    });

    it('should create an error without response data', () => {
      const error = new ApiError('Server error', 500, 'Internal Server Error');

      expect(error.message).toBe('Server error');
      expect(error.status).toBe(500);
      expect(error.statusText).toBe('Internal Server Error');
      expect(error.response).toBeUndefined();
    });

    it('should capture stack trace', () => {
      const error = new ApiError('Test error', 400, 'Bad Request');

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('ApiError');
    });
  });

  describe('isAuthError', () => {
    it('should return true for 401 status', () => {
      const error = new ApiError('Unauthorized', 401, 'Unauthorized');

      expect(error.isAuthError()).toBe(true);
    });

    it('should return true for 403 status', () => {
      const error = new ApiError('Forbidden', 403, 'Forbidden');

      expect(error.isAuthError()).toBe(true);
    });

    it('should return false for other status codes', () => {
      const error404 = new ApiError('Not found', 404, 'Not Found');
      const error500 = new ApiError(
        'Server error',
        500,
        'Internal Server Error',
      );

      expect(error404.isAuthError()).toBe(false);
      expect(error500.isAuthError()).toBe(false);
    });
  });

  describe('isClientError', () => {
    it('should return true for 4xx status codes', () => {
      const error400 = new ApiError('Bad request', 400, 'Bad Request');
      const error404 = new ApiError('Not found', 404, 'Not Found');
      const error422 = new ApiError(
        'Unprocessable',
        422,
        'Unprocessable Entity',
      );

      expect(error400.isClientError()).toBe(true);
      expect(error404.isClientError()).toBe(true);
      expect(error422.isClientError()).toBe(true);
    });

    it('should return false for non-4xx status codes', () => {
      const error200 = new ApiError('OK', 200, 'OK');
      const error500 = new ApiError(
        'Server error',
        500,
        'Internal Server Error',
      );

      expect(error200.isClientError()).toBe(false);
      expect(error500.isClientError()).toBe(false);
    });
  });

  describe('isServerError', () => {
    it('should return true for 5xx status codes', () => {
      const error500 = new ApiError(
        'Server error',
        500,
        'Internal Server Error',
      );
      const error502 = new ApiError('Bad gateway', 502, 'Bad Gateway');
      const error503 = new ApiError('Unavailable', 503, 'Service Unavailable');

      expect(error500.isServerError()).toBe(true);
      expect(error502.isServerError()).toBe(true);
      expect(error503.isServerError()).toBe(true);
    });

    it('should return false for non-5xx status codes', () => {
      const error400 = new ApiError('Bad request', 400, 'Bad Request');
      const error404 = new ApiError('Not found', 404, 'Not Found');

      expect(error400.isServerError()).toBe(false);
      expect(error404.isServerError()).toBe(false);
    });
  });

  describe('getUserMessage', () => {
    it('should return auth message for 401 error', () => {
      const error = new ApiError('Unauthorized', 401, 'Unauthorized');

      expect(error.getUserMessage()).toBe(
        'Authentication required. Please sign in.',
      );
    });

    it('should return auth message for 403 error', () => {
      const error = new ApiError('Forbidden', 403, 'Forbidden');

      expect(error.getUserMessage()).toBe(
        'Authentication required. Please sign in.',
      );
    });

    it('should return server error message for 5xx errors', () => {
      const error = new ApiError(
        'Internal error',
        500,
        'Internal Server Error',
      );

      expect(error.getUserMessage()).toBe(
        'Server error. Please try again later.',
      );
    });

    it('should return the error message for client errors', () => {
      const error = new ApiError('Invalid input', 400, 'Bad Request');

      expect(error.getUserMessage()).toBe('Invalid input');
    });

    it('should return default message if message is empty', () => {
      const error = new ApiError('', 400, 'Bad Request');

      expect(error.getUserMessage()).toBe(
        'An error occurred. Please try again.',
      );
    });

    it('returns session-specific copy for AUTH_SESSION_EXPIRED', () => {
      const error = new ApiError('Session expired', 401, 'Unauthorized', {
        code: 'AUTH_SESSION_EXPIRED',
      });

      expect(error.getUserMessage()).toBe(
        'Your session has expired. Please sign in again to continue.',
      );
    });
  });

  /**
   * Regression: a rate limit (429) and an admin usage-limit denial (403) were
   * both rendered as "Authentication required. Please sign in." — the 403
   * because isAuthError() covers it, the 429 because RATE_LIMIT_EXCEEDED used
   * to be mapped to 401 server-side. Users were told to fix the one thing
   * that was not wrong, and the server's actual message (wait time, which
   * limit was hit) was discarded.
   */
  describe('rate-limit and usage-limit errors', () => {
    it('identifies a burst rate limit by code, not status', () => {
      const error = new ApiError(
        'Rate limit exceeded. Try again in 30 seconds.',
        429,
        'Too Many Requests',
        {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      );
      expect(error.isRateLimitError()).toBe(true);
    });

    it('identifies an admin usage limit by code, despite sharing 403 with auth', () => {
      const error = new ApiError(
        "You've reached your limit of 100 requests today.",
        403,
        'Forbidden',
        {
          code: 'RATE_LIMIT_QUOTA_EXCEEDED',
        },
      );
      expect(error.isRateLimitError()).toBe(true);
      // Still an auth error BY STATUS — which is exactly why getUserMessage
      // must consult the code first.
      expect(error.isAuthError()).toBe(true);
    });

    it('does not mistake a genuine 403 for a limit', () => {
      const error = new ApiError('Forbidden', 403, 'Forbidden', {
        code: 'FORBIDDEN',
      });
      expect(error.isRateLimitError()).toBe(false);
    });

    it('does not mistake a bare 429 with no code for one of ours', () => {
      // An upstream 429 (e.g. an Azure model TPM limit) carries no such code
      // and SHOULD stay retryable on a fallback model.
      const error = new ApiError('Too Many Requests', 429, 'Too Many Requests');
      expect(error.isRateLimitError()).toBe(false);
    });

    it('surfaces the server message for a rate limit, NOT "please sign in"', () => {
      const error = new ApiError(
        'Rate limit exceeded. Try again in 30 seconds.',
        429,
        'Too Many Requests',
        {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      );
      expect(error.getUserMessage()).toBe(
        'Rate limit exceeded. Try again in 30 seconds.',
      );
      expect(error.getUserMessage()).not.toContain('sign in');
    });

    it('surfaces the server message for a usage limit, NOT "please sign in"', () => {
      const error = new ApiError(
        "You've reached your limit of 100 requests today.",
        403,
        'Forbidden',
        {
          code: 'RATE_LIMIT_QUOTA_EXCEEDED',
        },
      );
      expect(error.getUserMessage()).toBe(
        "You've reached your limit of 100 requests today.",
      );
      expect(error.getUserMessage()).not.toContain('sign in');
    });

    it('still tells a genuinely unauthenticated user to sign in', () => {
      const error = new ApiError('Unauthorized', 401, 'Unauthorized');
      expect(error.getUserMessage()).toBe(
        'Authentication required. Please sign in.',
      );
    });

    it('falls back to a generic sentence when the server sent no message', () => {
      const error = new ApiError('', 429, 'Too Many Requests', {
        code: 'RATE_LIMIT_EXCEEDED',
      });
      expect(error.getUserMessage()).toBe(
        'Usage limit reached. Please try again later.',
      );
    });
  });

  describe('error type checking', () => {
    it('should allow proper instanceof checks', () => {
      const error = new ApiError('Test', 400, 'Bad Request');

      expect(error instanceof Error).toBe(true);
      expect(error instanceof ApiError).toBe(true);
    });

    it('should distinguish from regular Error', () => {
      const apiError = new ApiError('API Error', 400, 'Bad Request');
      const regularError = new Error('Regular Error');

      expect(apiError instanceof ApiError).toBe(true);
      expect(regularError instanceof ApiError).toBe(false);
    });
  });
});
