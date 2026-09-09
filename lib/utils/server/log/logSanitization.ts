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

  // Remove control characters and normalize whitespace: this is what prevents
  // log injection via newlines, carriage returns, ANSI escape codes, etc.
  //
  // NOTE: stock CodeQL does NOT recognise this function as a CWE-117
  // barrier — the stripping happens inside `replace` chains it models as
  // value-preserving — so call sites used to raise js/log-injection even
  // though they are safe. That is now handled by the project query
  // `msf/log-injection` (.github/codeql/queries/LogInjection.ql), which
  // declares these helpers as sanitizers; the stock query is filtered out
  // in .github/codeql/codeql-config.yml so the two cannot double-report.
  //
  // Consequence for edits here: this function is load-bearing for the
  // scanner's correctness, not just tidy output. If it ever stops removing
  // CR/LF and control characters, the CodeQL barrier becomes a lie and real
  // log injection goes unreported. The literal alternation below is
  // equivalent to a `[\r\n]+` class; keep whichever reads better.
  return (
    stringValue
      .replace(/\r\n|\r|\n/g, ' ') // Replace newlines with spaces
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '') // Remove control characters
      .replace(/ {2,}/g, ' ') // Collapse runs left by consecutive newlines
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

/**
 * Schema-only description of a zod failure for logs: issue paths and
 * codes, never the received values (which came from stored/user data).
 */
export function zodIssueSummary(error: {
  issues: readonly { path: readonly PropertyKey[]; code: string }[];
}): string {
  return error.issues
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.path.map((p) => String(p)).join('.') || '<root>'}:${issue.code}`,
    )
    .join(', ');
}
