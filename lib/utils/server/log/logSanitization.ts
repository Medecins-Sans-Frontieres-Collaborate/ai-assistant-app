import { performance } from 'perf_hooks';
import { serializeError } from 'serialize-error';

/**
 * Sanitizes a value for safe logging by removing newlines, carriage returns,
 * and other control characters that could be used for log injection/forging.
 * Uses serialize-error for proper error serialization.
 *
 * @param value - The value to sanitize (string, number, object, etc.)
 * @returns A sanitized string safe for logging
 */
export function sanitizeForLog(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  let stringValue: string;

  if (typeof value === 'object') {
    try {
      // For Error objects, use serialize-error for safe serialization
      if (value instanceof Error) {
        const serialized = serializeError(value);
        stringValue = serialized.message || JSON.stringify(serialized);
      } else {
        // For other objects, stringify them
        stringValue = JSON.stringify(value);
      }
    } catch {
      stringValue = '[Object]';
    }
  } else {
    stringValue = String(value);
  }

  // Remove control characters and normalize whitespace
  // This prevents log injection via newlines, carriage returns, ANSI escape codes, etc.
  return (
    stringValue
      .replace(/[\r\n]+/g, ' ') // Replace newlines with spaces
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
      .trim()
  );
}

/**
 * Sanitizes multiple values for safe logging
 * @param values - Array of values to sanitize
 * @returns Array of sanitized strings
 */
export function sanitizeForLogMultiple(...values: unknown[]): string[] {
  return values.map(sanitizeForLog);
}

/**
 * Logs a performance measurement, gated to non-production environments.
 * Suppresses [Perf] noise in production where it adds cost with no benefit.
 *
 * @param label - A descriptive label for the measured operation
 * @param startTime - The `performance.now()` timestamp when the operation started
 * @param extra - Optional extra context to append (will NOT be sanitized — caller must sanitize if needed)
 */
export function perfLog(label: string, startTime: number, extra?: string) {
  if (process.env.NODE_ENV === 'production') return;
  const ms = (performance.now() - startTime).toFixed(1);
  console.log(`[Perf] ${label}: ${ms}ms${extra ? ` ${extra}` : ''}`);
}
