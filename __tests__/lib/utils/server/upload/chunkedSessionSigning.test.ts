import {
  SESSION_TTL_MS,
  signChunkedSession,
  verifyChunkedSession,
} from '@/lib/utils/server/upload/chunkedSessionSigning';

import type { ChunkedUploadSession } from '@/lib/types/chunkedUpload';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const originalSecret = process.env.NEXTAUTH_SECRET;

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-chunked-upload-signing';
});

afterAll(() => {
  process.env.NEXTAUTH_SECRET = originalSecret;
});

const baseSession: ChunkedUploadSession = {
  uploadId: 'upload-abc',
  filename: 'report.xlsx',
  filetype: 'file',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  totalSize: 50 * 1024 * 1024,
  totalChunks: 5,
  chunkSize: 10 * 1024 * 1024,
  blobPath: 'user-1/uploads/files/upload-abc.xlsx',
};

describe('chunkedSessionSigning', () => {
  it('verifies a freshly signed session', () => {
    const signed = signChunkedSession(baseSession, 'user-1');
    const result = verifyChunkedSession(signed, 'user-1');
    expect(result.valid).toBe(true);
  });

  it('rejects a session signed for a different user', () => {
    const signed = signChunkedSession(baseSession, 'user-1');
    const result = verifyChunkedSession(signed, 'user-2');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/signature/i);
    }
  });

  it('rejects a session whose blobPath was tampered with', () => {
    const signed = signChunkedSession(baseSession, 'user-1');
    const tampered = { ...signed, blobPath: 'user-2/uploads/files/evil.xlsx' };
    const result = verifyChunkedSession(tampered, 'user-1');
    expect(result.valid).toBe(false);
  });

  it('rejects a session whose chunkSize was tampered with', () => {
    const signed = signChunkedSession(baseSession, 'user-1');
    const tampered = { ...signed, chunkSize: 1_000_000_000 };
    const result = verifyChunkedSession(tampered, 'user-1');
    expect(result.valid).toBe(false);
  });

  it('rejects a session with no signature', () => {
    const unsigned = { ...baseSession };
    const result = verifyChunkedSession(unsigned, 'user-1');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/not signed/i);
  });

  it('rejects expired sessions', () => {
    const signed = signChunkedSession(baseSession, 'user-1');
    const expired = { ...signed, expiresAt: Date.now() - 1000 };
    // Tampering with expiresAt breaks the signature too, but we also hit
    // the explicit expiry gate when the expiry is in the past.
    const result = verifyChunkedSession(expired, 'user-1');
    expect(result.valid).toBe(false);
  });

  it('sets expiresAt roughly 2 hours out', () => {
    const before = Date.now();
    const signed = signChunkedSession(baseSession, 'user-1');
    const after = Date.now();
    expect(signed.expiresAt).toBeGreaterThanOrEqual(before + SESSION_TTL_MS);
    expect(signed.expiresAt).toBeLessThanOrEqual(after + SESSION_TTL_MS);
  });

  it('rejects a session whose blobPath does not start with authed user namespace', () => {
    // Force a scenario where HMAC would validate but namespace wouldn't —
    // construct a valid signature over a blobPath in userA's namespace, then
    // verify against userA. The namespace check passes. Now make blobPath
    // lead with a different prefix while keeping it consistent.
    const orphan = {
      ...baseSession,
      blobPath: 'other-container/uploads/files/upload-abc.xlsx',
    };
    const signed = signChunkedSession(orphan, 'user-1');
    const result = verifyChunkedSession(signed, 'user-1');
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/namespace/i);
  });
});
