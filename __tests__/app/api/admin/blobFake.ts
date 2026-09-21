/**
 * In-memory blob store with REAL compare-and-swap semantics, installed over
 * the blobCas mocks, so route tests run the production read-modify-write
 * loops rather than a mock of them.
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';

import { vi } from 'vitest';

export interface BlobFake {
  seed: (path: string, body: unknown) => void;
  read: <T>(path: string) => T | null;
  paths: () => string[];
}

export function installBlobFake(): BlobFake {
  const blobs = new Map<string, { text: string; etag: string }>();
  let counter = 0;
  const seed = (path: string, body: unknown) => {
    blobs.set(path, {
      text: typeof body === 'string' ? body : JSON.stringify(body),
      etag: `"e${++counter}"`,
    });
  };
  vi.mocked(downloadBlob).mockImplementation(async (_storage, path) => {
    const blob = blobs.get(path);
    return blob
      ? { buffer: Buffer.from(blob.text, 'utf8'), etag: blob.etag }
      : null;
  });
  vi.mocked(uploadJson).mockImplementation(
    async (_storage, path, payload, condition) => {
      const existing = blobs.get(path);
      if (condition === null && existing) throw new AgentAccessConflictError();
      if (typeof condition === 'string' && existing?.etag !== condition) {
        throw new AgentAccessConflictError();
      }
      seed(path, payload);
      return blobs.get(path)!.etag;
    },
  );
  return {
    seed,
    read: <T>(path: string) => {
      const blob = blobs.get(path);
      return blob ? (JSON.parse(blob.text) as T) : null;
    },
    paths: () => [...blobs.keys()],
  };
}
