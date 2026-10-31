/**
 * Provider error taxonomy for the chat loop.
 *
 * Every failure a model call can produce — an OpenAI / Anthropic SDK
 * `APIError`, an undici network error, an abort — is reduced to one
 * `ProviderErrorKind`, and *retryability* is derived from the kind rather
 * than from where the failure happened. The retry policy
 * (`modelRetry.ts`), the stream processors, the tool loop and the chat
 * route all consume this one classification, so "is this worth another
 * attempt?" is answered in exactly one place.
 *
 * Pure: no I/O, no SDK imports (duck-typed on the SDK error shapes so it
 * works for both the `openai` and `@anthropic-ai/sdk` error classes, which
 * share `status`, `code`, `headers` and `error` fields).
 */

export type ProviderErrorKind =
  /** HTTP 429 — the deployment / tenant is at its TPM or RPM ceiling. */
  | 'rate_limit'
  /** HTTP 5xx (incl. Anthropic 529 overloaded) — the provider's problem. */
  | 'provider_internal'
  /** Connection-level failure: reset, DNS, socket hang up, premature close. */
  | 'transport'
  /** The SDK's own connect / read timeout, or HTTP 408 / 504. */
  | 'timeout'
  /** HTTP 401 / 403 — credential or permission problem. */
  | 'auth'
  /** HTTP 402, or an explicit quota / billing rejection. */
  | 'quota'
  /** The request or the response tripped the provider's content policy. */
  | 'content_filter'
  /** The prompt does not fit the model's context window. */
  | 'context_overflow'
  /** Other 4xx — malformed request, unsupported parameter, bad schema. */
  | 'invalid_request'
  /** HTTP 404 "deployment not found" — handled by the fallback chain. */
  | 'deployment_not_found'
  /** The stream ended without a terminal event (provider cut mid-answer). */
  | 'incomplete_stream'
  /** Our own cancellation (stage timeout, client gone). Never retried. */
  | 'aborted'
  /** Nothing recognisable. Retried once by policy (see `isRetryableKind`). */
  | 'unknown';

export interface ClassifiedProviderError {
  kind: ProviderErrorKind;
  /** Whether another attempt at the SAME request could succeed. */
  retryable: boolean;
  /** Provider-requested wait (Retry-After), when it sent one. */
  retryAfterMs?: number;
  /** HTTP status when the failure was an HTTP response. */
  status?: number;
  /** Provider error code (`content_filter`, `context_length_exceeded`, …). */
  code?: string;
  /** Raw message, for server logs only — never shown to the user. */
  message: string;
}

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> =
  new Set<ProviderErrorKind>([
    'rate_limit',
    'provider_internal',
    'transport',
    'timeout',
    'incomplete_stream',
    // Transient failures arrive in shapes no classifier anticipates — an
    // unrecognised error is worth ONE more attempt (the policy caps it).
    'unknown',
  ]);

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

const CONTENT_FILTER_RE =
  /content[_ ]filter|content management policy|ResponsibleAIPolicyViolation|content_policy_violation|flagged by|safety system|harmful content|refus(al|ed) by the model/i;
const CONTEXT_OVERFLOW_RE =
  /context[_ ]length|maximum context length|context window|too many tokens|prompt is too long|input is too long|exceeds the (model'?s )?(maximum|limit)|reduce (the length|your prompt)|max(imum)? (input )?tokens|token limit|request too large|input length and `max_tokens` exceed/i;
const DEPLOYMENT_NOT_FOUND_RE = /deployment.*not\s*found/i;
const TRANSPORT_RE =
  /fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|network ?error|premature close|terminated|connection (was )?(closed|reset|refused)|other side closed|stream (was )?(closed|destroyed)|aborted by the server/i;
const TIMEOUT_RE = /timed? ?out|timeout/i;
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
]);

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  headers?: unknown;
  error?: unknown;
  cause?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  const maybeHeaders = headers as {
    get?: (key: string) => string | null | undefined;
  };
  if (typeof maybeHeaders.get === 'function') {
    const value = maybeHeaders.get(name) ?? maybeHeaders.get(lower);
    return value ?? undefined;
  }
  const record = asRecord(headers);
  if (!record) return undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  }
  return undefined;
}

/**
 * Retry-After as milliseconds: `Retry-After` is seconds or an HTTP date;
 * OpenAI also sends `retry-after-ms`. Returns undefined when absent or
 * unparsable, and never a negative number.
 */
export function parseRetryAfterMs(
  headers: unknown,
  now: number = Date.now(),
): number | undefined {
  const ms = readHeader(headers, 'retry-after-ms');
  if (ms !== undefined) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed);
  }
  const raw = readHeader(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

/** Nested provider error code: `{ error: { code } }` or `{ error: { innererror: { code } } }`. */
function nestedCode(error: ErrorLike): string {
  const body = asRecord(error.error);
  const inner = asRecord(body?.error) ?? body;
  const innerError = asRecord(inner?.innererror);
  const candidates = [
    error.code,
    inner?.code,
    innerError?.code,
    inner?.type,
    error.type,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

function nestedMessage(error: ErrorLike): string {
  const own = typeof error.message === 'string' ? error.message : '';
  const body = asRecord(error.error);
  const inner = asRecord(body?.error) ?? body;
  const innerMessage =
    typeof inner?.message === 'string' ? (inner.message as string) : '';
  return [own, innerMessage].filter(Boolean).join(' | ');
}

function readStatus(error: ErrorLike): number | undefined {
  const raw = error.status ?? error.statusCode;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d{3}$/.test(raw)) return Number(raw);
  return undefined;
}

function isAbort(error: ErrorLike, message: string): boolean {
  if (error.name === 'AbortError') return true;
  if (error.code === 'ABORT_ERR') return true;
  // Our own `signal.throwIfAborted()` reasons and the SDK's wording.
  return /^(The operation was aborted|This operation was aborted|Request was aborted)/i.test(
    message,
  );
}

function looksLikeNetworkFailure(error: ErrorLike, message: string): boolean {
  if (typeof error.code === 'string' && NETWORK_CODES.has(error.code))
    return true;
  const cause = asRecord(error.cause);
  if (cause && typeof cause.code === 'string' && NETWORK_CODES.has(cause.code))
    return true;
  if (error.name === 'APIConnectionError') return true;
  if (TRANSPORT_RE.test(message)) return true;
  const causeMessage =
    cause && typeof cause.message === 'string' ? cause.message : '';
  return TRANSPORT_RE.test(causeMessage);
}

/**
 * Classify a thrown model-call error. Safe on anything (strings, nulls,
 * plain objects) — the result always carries a kind.
 */
export function classifyProviderError(raw: unknown): ClassifiedProviderError {
  const error: ErrorLike = asRecord(raw) ?? {
    message: typeof raw === 'string' ? raw : String(raw),
  };
  const message = nestedMessage(error) || String(raw);
  const status = readStatus(error);
  const code = nestedCode(error);
  const finish = (
    kind: ProviderErrorKind,
    extra: Partial<ClassifiedProviderError> = {},
  ): ClassifiedProviderError => {
    const override = readHeader(error.headers, 'x-should-retry');
    const retryable =
      override === 'true'
        ? true
        : override === 'false'
          ? false
          : isRetryableKind(kind);
    return {
      kind,
      retryable,
      message,
      ...(status !== undefined ? { status } : {}),
      ...(code ? { code } : {}),
      ...extra,
    };
  };

  if (isAbort(error, message)) return finish('aborted');

  // Semantic codes beat status codes: Azure reports a filtered PROMPT as a
  // 400 and a filtered COMPLETION as a stream event, and the context limit
  // as a 400 with a dedicated code.
  if (
    /^content_filter$/i.test(code) ||
    code === 'ResponsibleAIPolicyViolation' ||
    CONTENT_FILTER_RE.test(code) ||
    (status !== undefined && status < 500 && CONTENT_FILTER_RE.test(message))
  )
    return finish('content_filter');
  if (
    /context_length_exceeded|context_window_exceeded|prompt_too_long|input_too_long|request_too_large/i.test(
      code,
    ) ||
    status === 413 ||
    ((status === 400 || status === 422 || status === undefined) &&
      CONTEXT_OVERFLOW_RE.test(message) &&
      !looksLikeNetworkFailure(error, message))
  )
    return finish('context_overflow');
  // Mirrors config/models.ts isDeploymentNotFoundError so the retry policy
  // and the fallback chain agree: a missing deployment is never retried.
  if (
    code === 'DeploymentNotFound' ||
    ((status === 404 || code === '404') &&
      DEPLOYMENT_NOT_FOUND_RE.test(message))
  )
    return finish('deployment_not_found');

  if (status !== undefined) {
    const retryAfterMs = parseRetryAfterMs(error.headers);
    if (status === 429)
      return finish(
        'rate_limit',
        retryAfterMs !== undefined ? { retryAfterMs } : {},
      );
    if (status === 401 || status === 403) return finish('auth');
    if (status === 402 || /insufficient_quota|quota/i.test(code))
      return finish('quota');
    if (status === 408 || status === 504 || status === 524)
      return finish('timeout');
    if (status >= 500)
      return finish(
        'provider_internal',
        retryAfterMs !== undefined ? { retryAfterMs } : {},
      );
    if (status >= 400) return finish('invalid_request');
  }

  if (error.name === 'APIConnectionTimeoutError') return finish('timeout');
  if (looksLikeNetworkFailure(error, message)) return finish('transport');
  if (TIMEOUT_RE.test(message) && !/model did not start/i.test(message))
    return finish('timeout');

  // Programming errors in our own code must surface, not be retried.
  if (
    raw instanceof TypeError ||
    raw instanceof RangeError ||
    raw instanceof SyntaxError ||
    raw instanceof ReferenceError
  )
    return { kind: 'unknown', retryable: false, message };

  return finish('unknown');
}

/**
 * Client-safe sentence for a classified failure. Provider wording never
 * reaches the browser — it can carry deployment names, request ids and
 * tenant details.
 */
export function describeProviderError(kind: ProviderErrorKind): string {
  switch (kind) {
    case 'rate_limit':
      return 'The model is receiving too many requests right now. It was retried automatically; please try again in a moment.';
    case 'provider_internal':
      return 'The model service reported an internal error. It was retried automatically; please try again.';
    case 'transport':
      return 'The connection to the model service was interrupted. Please try again.';
    case 'timeout':
      return 'The model service did not answer in time. Please try again.';
    case 'auth':
      return 'The model service rejected this request. The application may need to be reconfigured; contact an administrator if this persists.';
    case 'quota':
      return 'The model service reported that its usage quota is exhausted.';
    case 'content_filter':
      return 'The response was stopped by the content safety filter. Rephrase the request, or remove the part that may have triggered it.';
    case 'context_overflow':
      return 'This conversation is too long for the selected model. Start a new conversation, or remove some attachments.';
    case 'invalid_request':
      return 'The model service rejected the request as invalid.';
    case 'deployment_not_found':
      return 'The selected model is not available right now.';
    case 'incomplete_stream':
      return 'The model stopped before the answer was finished.';
    case 'aborted':
      return 'The request was cancelled.';
    case 'unknown':
    default:
      return 'The model request failed. Please try again.';
  }
}

/**
 * Stable wire code for a classified failure. Shared by the route (pipeline
 * errors), the stream processors and the tool loop so the client branches
 * on one vocabulary. Kinds that already had an ErrorCode keep it.
 */
export function providerErrorCode(kind: ProviderErrorKind): string {
  switch (kind) {
    case 'rate_limit':
      return 'MODEL_RATE_LIMITED';
    case 'context_overflow':
      return 'MODEL_CONTEXT_TOO_LONG';
    case 'content_filter':
      return 'MODEL_CONTENT_FILTERED';
    case 'deployment_not_found':
      return 'MODEL_UNAVAILABLE';
    case 'timeout':
      return 'MODEL_TIMEOUT';
    case 'auth':
      return 'MODEL_AUTH_FAILED';
    case 'quota':
      return 'MODEL_QUOTA_EXCEEDED';
    case 'invalid_request':
      return 'MODEL_INVALID_REQUEST';
    case 'aborted':
      return 'REQUEST_ABORTED';
    case 'provider_internal':
    case 'transport':
    case 'incomplete_stream':
    case 'unknown':
    default:
      return 'UPSTREAM_STREAM_FAILED';
  }
}
