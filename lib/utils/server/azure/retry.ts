/**
 * Retry helper for Azure SDK calls.
 *
 * Retries only transient failures:
 *  - HTTP 5xx responses
 *  - Network errors (no status, but error has a connection-reset/DNS code)
 *
 * Explicitly does NOT retry 4xx responses (bad request, unauthorized, not found,
 * etc.) — those are user/config errors that won't resolve by trying again.
 */

/** Default attempts = 3 (initial + 2 retries). */
const DEFAULT_ATTEMPTS = 3;

/** Backoff schedule in ms between attempts. */
const DEFAULT_BACKOFF_MS = [100, 300, 1000] as const;

interface RetryOptions {
  /** Total number of attempts (initial + retries). Clamped to [1, 5]. */
  attempts?: number;
  /** Label for log output. */
  label?: string;
}

/** Network-level error codes we consider transient. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
]);

export function isTransientAzureError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { statusCode?: number; status?: number; code?: string };
  const status = err.statusCode ?? err.status;
  if (typeof status === 'number') {
    return status >= 500 && status < 600;
  }
  if (typeof err.code === 'string' && TRANSIENT_NETWORK_CODES.has(err.code)) {
    return true;
  }
  return false;
}

export async function withAzureRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(
    1,
    Math.min(5, options.attempts ?? DEFAULT_ATTEMPTS),
  );
  const label = options.label ?? 'azure-op';

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientAzureError(error)) {
        throw error;
      }
      const backoff =
        DEFAULT_BACKOFF_MS[
          Math.min(attempt - 1, DEFAULT_BACKOFF_MS.length - 1)
        ];
      const err = error as { statusCode?: number; message?: string };
      console.warn(
        `[AzureRetry:${label}] transient failure (status=${err.statusCode ?? 'n/a'}), ` +
          `retrying in ${backoff}ms (attempt ${attempt}/${attempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
  // Unreachable, but satisfies TS.
  throw lastError;
}
