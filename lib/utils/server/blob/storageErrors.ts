/**
 * Classifies Azure Blob Storage failures so callers can distinguish an
 * infrastructure/configuration problem (storage firewall blocking the request,
 * the account unreachable, a missing container) from a genuine client error or
 * an unknown bug — and respond with an honest status, a stable `errorClass`
 * for alerting, and a message that doesn't read like "your file is bad" when
 * the real cause is server-side.
 *
 * Context: EU uploads once returned an opaque 500 because the EU storage
 * account's firewall rejected the container app at the network layer (403
 * `AuthorizationFailure`) before auth was even evaluated. That is an infra
 * problem, not a user problem, and it should be observable as one.
 */

/**
 * Stable, low-cardinality tags for blob failures. Logged as the error code so
 * dashboards/alerts can group on them.
 */
export type StorageErrorClass =
  | 'storage_unreachable' // network-level failure reaching the account (DNS/conn/timeout)
  | 'storage_forbidden' // 403 — firewall/RBAC denied; almost always config, not the user
  | 'storage_not_found' // 404 — account/container/path missing (likely half-provisioned)
  | 'unknown'; // anything we can't confidently attribute

export interface ClassifiedStorageError {
  errorClass: StorageErrorClass;
  /** HTTP status to return to the client. */
  status: number;
  /** User-facing message — honest about server-side vs client-side fault. */
  message: string;
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Extracts the bits we care about from an unknown thrown value. Azure SDK
 * `RestError`s expose `statusCode` + `code`; Node network errors expose `code`.
 */
function extract(error: unknown): { statusCode?: number; code?: string } {
  if (!error || typeof error !== 'object') return {};
  const e = error as { statusCode?: unknown; code?: unknown };
  return {
    statusCode: typeof e.statusCode === 'number' ? e.statusCode : undefined,
    code: typeof e.code === 'string' ? e.code : undefined,
  };
}

/**
 * Maps a thrown blob-storage error to an {@link ClassifiedStorageError}.
 * Never throws; falls back to `unknown`/500 for anything unrecognized.
 */
export function classifyStorageError(error: unknown): ClassifiedStorageError {
  const { statusCode, code } = extract(error);

  if (code && NETWORK_CODES.has(code)) {
    return {
      errorClass: 'storage_unreachable',
      status: 503,
      message: 'File storage is temporarily unreachable. Please try again.',
    };
  }

  if (
    statusCode === 403 ||
    code === 'AuthorizationFailure' ||
    code === 'AuthorizationPermissionMismatch' ||
    code === 'AuthenticationFailed' ||
    code === 'KeyVaultEncryptionKeyNotFound'
  ) {
    return {
      errorClass: 'storage_forbidden',
      status: 502,
      message:
        'File storage is currently unavailable due to a server configuration issue. Please contact support if this persists.',
    };
  }

  if (
    statusCode === 404 ||
    code === 'ContainerNotFound' ||
    code === 'AccountIsDisabled'
  ) {
    return {
      errorClass: 'storage_not_found',
      status: 502,
      message:
        'File storage is currently unavailable due to a server configuration issue. Please contact support if this persists.',
    };
  }

  return {
    errorClass: 'unknown',
    status: 500,
    message: 'Failed to upload file',
  };
}
