import { NextRequest } from 'next/server';

import { BackupConflictError } from '@/lib/services/backup/server/backupBlobStore';
import {
  DriveRateLimitError,
  deleteDriveBackup,
  deleteDriveBlob,
  driveConversationPath,
  driveFoldersPath,
  readDriveBlob,
  readDriveManifest,
  writeDriveImmutableBlob,
  writeDriveManifest,
} from '@/lib/services/backup/server/backupDriveStore';
import { BackupManifest } from '@/lib/services/backup/types';
import { M365Error, mintGraphToken } from '@/lib/services/m365/graphApi';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// graphApi statically imports @/auth (next-auth), which cannot load in the
// node test environment — and mintGraphToken is mocked anyway.
vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getGraphAccessToken: vi.fn(),
}));

vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return {
    ...actual,
    mintGraphToken: vi.fn(),
  };
});

const REV = '0123456789abcdef';

const manifest: BackupManifest = {
  schemaVersion: 1,
  keyId: 'a1b2c3d4e5f60718',
  epoch: 1,
  version: 1,
  updatedAt: '2026-08-01T00:00:00.000Z',
  folders: null,
  conversations: {},
};

function req(): NextRequest {
  return new NextRequest('http://localhost:3000/api/backup/manifest');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mintGraphToken).mockResolvedValue('graph-token');
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('path builders', () => {
  it('builds validated relative paths', () => {
    expect(driveConversationPath('conv1', REV)).toBe(`conv/conv1.${REV}.bin`);
    expect(driveFoldersPath(REV)).toBe(`folders.${REV}.bin`);
  });

  it('rejects ids and revs that could alter the Graph path', () => {
    expect(() => driveConversationPath('../evil', REV)).toThrow();
    expect(() => driveConversationPath('conv1', 'nothex')).toThrow();
    expect(() => driveFoldersPath('short')).toThrow();
  });
});

describe('readDriveManifest', () => {
  it('returns null when the manifest item does not exist', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await readDriveManifest(req())).toBeNull();
  });

  it('returns manifest + item eTag via the metadata → downloadUrl pair', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          eTag: '"{ABC},1"',
          '@microsoft.graph.downloadUrl': 'https://download.example/m',
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest)));

    const result = await readDriveManifest(req());
    expect(result).toEqual({ manifest, etag: '"{ABC},1"' });
    // Metadata call is authorized; the pre-authed downloadUrl fetch is not.
    expect(fetchMock.mock.calls[0][0]).toContain(
      '/me/drive/root:/Apps/AI%20Assistant/Backup/manifest.json:',
    );
    expect(fetchMock.mock.calls[1][0]).toBe('https://download.example/m');
    expect(fetchMock.mock.calls[1][1]).toBeUndefined();
  });

  it('maps Graph 429 to DriveRateLimitError with Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { 'Retry-After': '17' } }),
    );
    await expect(readDriveManifest(req())).rejects.toMatchObject({
      name: 'DriveRateLimitError',
      retryAfterSeconds: 17,
    });
  });
});

describe('writeDriveManifest', () => {
  it('create-only uses conflictBehavior=fail and returns the new eTag', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ eTag: '"{NEW},1"' }, 201));
    const etag = await writeDriveManifest(req(), manifest, null);
    expect(etag).toBe('"{NEW},1"');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('conflictBehavior=fail');
    expect(
      (init.headers as Record<string, string>)['If-Match'],
    ).toBeUndefined();
  });

  it('maps a create-only 409 (nameAlreadyExists) to BackupConflictError', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'nameAlreadyExists' } }, 409),
    );
    await expect(writeDriveManifest(req(), manifest, null)).rejects.toThrow(
      BackupConflictError,
    );
  });

  it('CAS update sends If-Match and maps 412 to BackupConflictError', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 412 }));
    await expect(
      writeDriveManifest(req(), manifest, '"{OLD},3"'),
    ).rejects.toThrow(BackupConflictError);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('conflictBehavior');
    expect((init.headers as Record<string, string>)['If-Match']).toBe(
      '"{OLD},3"',
    );
  });

  it('maps a Graph 403 to a typed M365Error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { message: 'denied' } }, 403),
    );
    await expect(
      writeDriveManifest(req(), manifest, '"{OLD},3"'),
    ).rejects.toBeInstanceOf(M365Error);
  });
});

describe('writeDriveImmutableBlob', () => {
  it('small blobs are a single create-only content PUT', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ eTag: '"{B},1"' }, 201));
    await writeDriveImmutableBlob(
      req(),
      driveConversationPath('conv1', REV),
      Buffer.from([1, 2, 3]),
    );
    const [url, init] = fetchMock.mock.calls[0];
    // Path segments are encoded individually, so the separator stays literal.
    expect(url).toContain(`/conv/conv1.${REV}.bin`);
    expect(url).toContain('conflictBehavior=fail');
    expect(init.method).toBe('PUT');
  });

  it('treats a name conflict as idempotent success (rev-named content)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'nameAlreadyExists' } }, 409),
    );
    await expect(
      writeDriveImmutableBlob(
        req(),
        driveFoldersPath(REV),
        Buffer.from([1, 2, 3]),
      ),
    ).resolves.toBeUndefined();
  });

  it('large blobs go through an upload session in Content-Range fragments', async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ uploadUrl: 'https://upload.example/session' }),
      )
      .mockResolvedValue(jsonResponse({ id: 'item' }, 201));

    await writeDriveImmutableBlob(req(), driveFoldersPath(REV), bytes);

    expect(fetchMock.mock.calls[0][0]).toContain('/createUploadSession');
    const fragmentCall = fetchMock.mock.calls[1];
    expect(fragmentCall[0]).toBe('https://upload.example/session');
    expect(
      (fragmentCall[1].headers as Record<string, string>)['Content-Range'],
    ).toMatch(/^bytes 0-\d+\/5242880$/);
  });
});

describe('readDriveBlob / deletes', () => {
  it('readDriveBlob returns bytes, null on 404', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          eTag: '"{X},1"',
          '@microsoft.graph.downloadUrl': 'https://download.example/b',
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 8])));
    const buffer = await readDriveBlob(req(), driveFoldersPath(REV));
    expect([...(buffer as Buffer)]).toEqual([9, 8]);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await readDriveBlob(req(), driveFoldersPath(REV))).toBeNull();
  });

  it('deleteDriveBlob and deleteDriveBackup are idempotent on 404', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await deleteDriveBlob(req(), driveFoldersPath(REV))).toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await deleteDriveBlob(req(), driveFoldersPath(REV))).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await deleteDriveBackup(req())).toBe(0);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await deleteDriveBackup(req())).toBe(1);
  });

  it('deleteDriveBackup targets the whole backup folder', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await deleteDriveBackup(req());
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /\/me\/drive\/root:\/Apps\/AI%20Assistant\/Backup:$/,
    );
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });
});
