/**
 * Single client-side mapping from M365 API error codes to semantic kinds.
 * Consumers translate a kind into their own namespace's message key — the
 * kind switch itself must not be re-implemented per component (five copies
 * had already drifted apart on which codes they recognized).
 */
import { M365ClientError } from '@/client/services/m365/m365Client';

export type M365ErrorKind =
  | 'consentMissing'
  | 'notConnected'
  | 'network'
  | 'fileTooLarge'
  | 'invalidContent'
  | 'isFolder'
  | 'notFound'
  | 'forbidden'
  | 'rateLimited'
  | 'generic';

const CODE_TO_KIND: Record<string, M365ErrorKind> = {
  M365_CONSENT_MISSING: 'consentMissing',
  M365_NOT_CONNECTED: 'notConnected',
  NETWORK: 'network',
  M365_FILE_TOO_LARGE: 'fileTooLarge',
  M365_INVALID_CONTENT: 'invalidContent',
  M365_IS_FOLDER: 'isFolder',
  M365_NOT_FOUND: 'notFound',
  M365_FORBIDDEN: 'forbidden',
  M365_RATE_LIMITED: 'rateLimited',
};

export function m365ErrorKind(error: unknown): M365ErrorKind {
  if (error instanceof M365ClientError && error.code) {
    return CODE_TO_KIND[error.code] ?? 'generic';
  }
  return 'generic';
}
