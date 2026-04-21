import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Absolute caps enforced server-side on every chunked upload, independent of
 * the session values the client claims. Prevents an attacker who replays or
 * forges a session from driving the blob past the category size limit.
 */
export const MAX_CHUNK_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const MAX_TOTAL_CHUNKS = 10_000;
export const MAX_TOTAL_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Session shape after signing. Carries the fields the server needs to verify
 * on every subsequent chunk or finalize call.
 */
export interface SignedChunkedUploadSession extends ChunkedUploadSession {
  expiresAt: number;
  signature: string;
}

function getSigningSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      'Chunked upload signing requires NEXTAUTH_SECRET or AUTH_SECRET to be set',
    );
  }
  return secret;
}

function canonicalPayload(
  session: ChunkedUploadSession,
  userId: string,
  expiresAt: number,
): string {
  // Order-sensitive. Every field the server enforces must be in the HMAC so
  // the client cannot flip any of them between init and chunk/finalize.
  return [
    'v1',
    userId,
    session.uploadId,
    session.blobPath,
    session.filetype,
    session.mimeType ?? '',
    String(session.totalSize),
    String(session.totalChunks),
    String(session.chunkSize),
    String(expiresAt),
  ].join('|');
}

/**
 * Produces a session augmented with `expiresAt` + HMAC signature. The client
 * echoes this back on every subsequent call; the server verifies before
 * trusting any field.
 */
export function signChunkedSession(
  session: ChunkedUploadSession,
  userId: string,
): SignedChunkedUploadSession {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = canonicalPayload(session, userId, expiresAt);
  const signature = createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('hex');
  return { ...session, expiresAt, signature };
}

export type VerifyResult =
  | { valid: true; session: SignedChunkedUploadSession }
  | { valid: false; reason: string };

/**
 * Verifies a session returned by the client. Re-derives the userId from the
 * authenticated request rather than trusting anything about the session. If
 * the signature matches, checks expiry and namespace ownership.
 */
export function verifyChunkedSession(
  session: ChunkedUploadSession | SignedChunkedUploadSession | undefined | null,
  authedUserId: string,
): VerifyResult {
  if (!session || typeof session !== 'object') {
    return { valid: false, reason: 'Missing upload session' };
  }

  const maybeSigned = session as Partial<SignedChunkedUploadSession>;
  if (!maybeSigned.signature || typeof maybeSigned.signature !== 'string') {
    return { valid: false, reason: 'Upload session is not signed' };
  }
  if (!maybeSigned.expiresAt || typeof maybeSigned.expiresAt !== 'number') {
    return { valid: false, reason: 'Upload session is missing expiry' };
  }

  // Reject expired sessions before touching HMAC (no information leak here —
  // expiresAt is part of the payload and the client already knows it).
  if (maybeSigned.expiresAt < Date.now()) {
    return { valid: false, reason: 'Upload session expired' };
  }

  const expected = createHmac('sha256', getSigningSecret())
    .update(
      canonicalPayload(
        session as ChunkedUploadSession,
        authedUserId,
        maybeSigned.expiresAt,
      ),
    )
    .digest('hex');

  const providedBuf = Buffer.from(maybeSigned.signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return { valid: false, reason: 'Upload session signature invalid' };
  }

  // Defense in depth: the blobPath must live under the authenticated user's
  // namespace even if the HMAC checks out (e.g., secret rotation edge cases).
  const expectedPrefix = `${authedUserId}/uploads/`;
  if (!session.blobPath.startsWith(expectedPrefix)) {
    return { valid: false, reason: 'Upload session namespace mismatch' };
  }

  return { valid: true, session: session as SignedChunkedUploadSession };
}
