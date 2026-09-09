/**
 * Error Extraction Utilities for API Observability
 *
 * Provides utilities to extract error information from unknown error types,
 * replacing the common pattern of `error instanceof Error ? error.message : 'Unknown error'`.
 */

/**
 * Details extracted from an error for logging purposes.
 */
export interface ErrorDetails {
  /** The error message */
  message: string;
  /** The stack trace, if available */
  stackTrace?: string;
}

/**
 * Extracts an error message from an unknown error value.
 *
 * Handles the common cases:
 * - Error instances: returns `error.message`
 * - Strings: returns the string directly
 * - Other values: returns the fallback message
 *
 * @param error - The caught error value (can be anything)
 * @param fallback - The message to return if error type is unrecognized
 * @returns A string error message
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   logger.logError({ errorMessage: getErrorMessage(error) });
 * }
 * ```
 */
export function getErrorMessage(
  error: unknown,
  fallback: string = 'Unknown error',
): string {
  if (error instanceof Error) {
    if (error.message) {
      return error.message;
    }
    // Azure SDK RestErrors can carry a BLANK message with the real signal in
    // code/statusCode (storage auth failures do this) — surface those
    // instead of returning ''.
    const { code, statusCode } = error as {
      code?: unknown;
      statusCode?: unknown;
    };
    const parts = [
      error.name !== 'Error' ? error.name : undefined,
      typeof code === 'string' ? code : undefined,
      typeof statusCode === 'number' ? `HTTP ${statusCode}` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : fallback;
  }
  if (typeof error === 'string') {
    return error;
  }
  return fallback;
}

/**
 * Extracts detailed error information including message and stack trace.
 *
 * @param error - The caught error value (can be anything)
 * @returns An object with message and optional stackTrace
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   const details = getErrorDetails(error);
 *   logger.logError({
 *     errorMessage: details.message,
 *     stackTrace: details.stackTrace,
 *   });
 * }
 * ```
 */
export function getErrorDetails(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    return {
      message: error.message,
      stackTrace: error.stack,
    };
  }
  return {
    message: typeof error === 'string' ? error : 'Unknown error',
  };
}
