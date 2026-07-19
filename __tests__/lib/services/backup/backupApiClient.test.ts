import {
  BackupApiError,
  createBackupApiClient,
} from '@/lib/services/backup/backupApiClient';
import type { BackupManifest } from '@/lib/services/backup/types';

import { describe, expect, it, vi } from 'vitest';

const manifest: BackupManifest = {
  schemaVersion: 1,
  keyId: 'a1b2c3d4e5f60718',
  epoch: 1,
  version: 3,
  updatedAt: '2026-07-01T10:00:00.000Z',
  folders: null,
  conversations: {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createBackupApiClient', () => {
  it('getManifest parses the success envelope into { manifest, etag }', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: true, data: { manifest, etag: '"abc"' } }),
      );
    const api = createBackupApiClient(fetchImpl);

    await expect(api.getManifest()).resolves.toEqual({
      manifest,
      etag: '"abc"',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/backup/manifest', {
      method: 'GET',
    });
  });

  it('getManifest resolves null on 404 instead of throwing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'Backup not found', code: 'BACKUP_NOT_FOUND' },
          404,
        ),
      );
    const api = createBackupApiClient(fetchImpl);

    await expect(api.getManifest()).resolves.toBeNull();
  });

  it('propagates the server error code and status in BackupApiError', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'Key mismatch', code: 'BACKUP_KEY_MISMATCH' },
          409,
        ),
      );
    const api = createBackupApiClient(fetchImpl);

    const err = await api
      .putManifest(manifest, { ifMatchEtag: '"abc"' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupApiError);
    expect((err as BackupApiError).code).toBe('BACKUP_KEY_MISMATCH');
    expect((err as BackupApiError).status).toBe(409);
    expect((err as BackupApiError).message).toBe('Key mismatch');
  });

  it('falls back to status-derived codes for unknown or non-JSON errors', async () => {
    const api409 = createBackupApiClient(
      vi.fn().mockResolvedValue(new Response('nope', { status: 409 })),
    );
    const conflict = await api409
      .putManifest(manifest, { ifMatchEtag: null })
      .catch((e: unknown) => e as BackupApiError);
    expect(conflict.code).toBe('BACKUP_VERSION_CONFLICT');

    const api500 = createBackupApiClient(
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })),
    );
    const unknown = await api500
      .getConversationBlob('c1', 'aaaaaaaaaaaaaaaa')
      .catch((e: unknown) => e as BackupApiError);
    expect(unknown.code).toBe('UNKNOWN');
    expect(unknown.status).toBe(500);
  });

  it('wraps fetch rejections as NETWORK errors with status 0', async () => {
    const api = createBackupApiClient(
      vi.fn().mockRejectedValue(new TypeError('failed to fetch')),
    );
    const err = await api
      .getManifest()
      .catch((e: unknown) => e as BackupApiError);
    expect(err).toBeInstanceOf(BackupApiError);
    expect(err.code).toBe('NETWORK');
    expect(err.status).toBe(0);
  });

  it('putManifest sends If-Match only when an etag is provided', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ success: true, data: { etag: '"v2"' } }),
      );
    const api = createBackupApiClient(fetchImpl);

    await expect(
      api.putManifest(manifest, { ifMatchEtag: '"v1"' }),
    ).resolves.toEqual({ etag: '"v2"' });
    let [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'If-Match': '"v1"' });
    expect(JSON.parse(init.body as string)).toEqual(manifest);

    fetchImpl.mockClear();
    fetchImpl.mockResolvedValue(
      jsonResponse({ success: true, data: { etag: '"v1"' } }),
    );
    await api.putManifest(manifest, { ifMatchEtag: null });
    [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('If-Match');
  });

  it('conversation blob round-trip uses octet-stream and encodes the id', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    const api = createBackupApiClient(fetchImpl);

    await api.putConversationBlob('c 1', 'aaaaaaaaaaaaaaaa', bytes);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/backup/conversations/c%201?rev=aaaaaaaaaaaaaaaa');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/octet-stream',
    });

    await expect(
      api.getConversationBlob('c 1', 'aaaaaaaaaaaaaaaa'),
    ).resolves.toEqual(bytes);
  });

  it('folders blob and backup deletion hit the expected routes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ success: true }));
    const api = createBackupApiClient(fetchImpl);

    await api.putFoldersBlob('bbbbbbbbbbbbbbbb', new Uint8Array([9]));
    expect(fetchImpl.mock.calls[0][0]).toBe(
      '/api/backup/folders?rev=bbbbbbbbbbbbbbbb',
    );

    await api.deleteBackup();
    expect(fetchImpl.mock.calls[1]).toEqual([
      '/api/backup',
      { method: 'DELETE' },
    ]);
  });
});
