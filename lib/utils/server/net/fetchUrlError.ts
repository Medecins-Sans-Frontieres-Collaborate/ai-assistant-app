/**
 * Failure taxonomy for user-initiated page fetches (`/api/workflows/fetch-url`).
 *
 * The code — not the message — is what the client renders from, so each one
 * maps to a distinct piece of advice. Every client-facing message ends with
 * the same "copy the text and paste it here instead" hint, composed once at
 * render rather than baked into a dozen translated strings.
 */

export type FetchUrlErrorCode =
  | 'INVALID_URL'
  | 'SSRF_BLOCKED'
  | 'TOO_MANY_REDIRECTS'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'BLOCKED'
  | 'NOT_FOUND'
  | 'UPSTREAM_ERROR'
  | 'PDF'
  | 'NON_HTML'
  | 'TOO_LARGE'
  | 'EMPTY_EXTRACTION';

const STATUS_BY_CODE: Record<FetchUrlErrorCode, number> = {
  INVALID_URL: 400,
  SSRF_BLOCKED: 400,
  TOO_MANY_REDIRECTS: 400,
  TIMEOUT: 504,
  UNREACHABLE: 502,
  BLOCKED: 403,
  NOT_FOUND: 404,
  UPSTREAM_ERROR: 502,
  PDF: 415,
  NON_HTML: 415,
  TOO_LARGE: 413,
  EMPTY_EXTRACTION: 422,
};

/** A fetch/extraction failure carrying the code the client branches on. */
export class FetchUrlError extends Error {
  readonly code: FetchUrlErrorCode;

  constructor(code: FetchUrlErrorCode, message: string) {
    super(message);
    this.name = 'FetchUrlError';
    this.code = code;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function isFetchUrlError(error: unknown): error is FetchUrlError {
  return error instanceof FetchUrlError;
}

export function statusForFetchUrlCode(code: FetchUrlErrorCode): number {
  return STATUS_BY_CODE[code];
}
