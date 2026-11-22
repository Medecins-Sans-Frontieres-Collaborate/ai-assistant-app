import { loadMasterKey } from '@/client/services/backup/keystore';
import {
  RunLockedError,
  RunMissingError,
  RunRequestError,
  fetchRunFile,
  isOneDriveUnavailable,
  loadRunRecord,
  newRunAccess,
  runFilesInUse,
  runKeyHeaders,
  saveRunRecord,
  syncRun,
} from '@/client/services/workflows/nativeRunStorage';

import { FormattedDocumentRun } from '@/lib/utils/shared/translation/formattedDocument';
import {
  RUN_KEY_HEADER,
  RUN_RECORD_ID,
  isEncryptedRunFile,
  runFileUrl,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/backup/keystore', () => ({
  loadMasterKey: vi.fn(),
}));

const RUN = '11111111-2222-4333-8444-555555555555';
const id = (letter: string, kind: string) => `${letter.repeat(64)}.${kind}`;
const MASTER = new Uint8Array(32).fill(5);
const OTHER_MASTER = new Uint8Array(32).fill(6);

const run = {
  sourceId: id('a', 'pdf'),
  unitsId: id('b', 'json'),
  pdfUrl: runFileUrl({ runId: RUN, backend: 'app' }, id('c', 'pdf')),
  pageImages: [
    {
      page: 1,
      previewUrl: runFileUrl({ runId: RUN, backend: 'app' }, id('d', 'png')),
      checkUrl: runFileUrl({ runId: RUN, backend: 'app' }, id('e', 'png')),
    },
  ],
  units: [{ id: 'p1u1', translation: 'Informe anual' }],
} as unknown as FormattedDocumentRun;

/** A server that keeps the record it is sent and answers with it. */
function recordServer() {
  let stored: Uint8Array | null = null;
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      stored = new Uint8Array(init.body as Uint8Array);
      return Response.json({ success: true });
    }
    return stored
      ? new Response(new Uint8Array(stored))
      : Response.json(
          { error: 'gone', code: 'RUN_FILES_MISSING' },
          { status: 404 },
        );
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, stored: () => stored };
}

beforeEach(() => {
  vi.mocked(loadMasterKey).mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('run identity', () => {
  it('starts an unencrypted run on a device without a backup key', async () => {
    const access = await newRunAccess('app');
    expect(access.backend).toBe('app');
    expect(access.keyId).toBeUndefined();
    expect(await runKeyHeaders(access)).toEqual({});
  });

  it('starts an encrypted run on a device with one, and sends its key', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(MASTER);
    const access = await newRunAccess('onedrive');
    expect(access.keyId).toMatch(/^[0-9a-f]{16}$/);
    const headers = await runKeyHeaders(access);
    expect(headers[RUN_KEY_HEADER]).toBeTruthy();
    // Never the backup key itself.
    expect(headers[RUN_KEY_HEADER]).not.toBe(
      Buffer.from(MASTER).toString('base64'),
    );
  });

  it('refuses to work on an encrypted run without its key', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(MASTER);
    const access = await newRunAccess('app');
    vi.mocked(loadMasterKey).mockResolvedValue(null);
    await expect(runKeyHeaders(access)).rejects.toMatchObject({
      reason: 'no-key',
    });
    vi.mocked(loadMasterKey).mockResolvedValue(OTHER_MASTER);
    await expect(runKeyHeaders(access)).rejects.toMatchObject({
      reason: 'other-key',
    });
  });
});

describe('the run record', () => {
  it('is saved and read back as it is, when the run is not encrypted', async () => {
    const server = recordServer();
    const access = { runId: RUN, backend: 'app' as const };
    await saveRunRecord(access, run);
    expect(isEncryptedRunFile(server.stored()!)).toBe(false);
    expect(await loadRunRecord(access)).toEqual(run);
  });

  it('is encrypted before it leaves the browser, when the run is', async () => {
    vi.mocked(loadMasterKey).mockResolvedValue(MASTER);
    const server = recordServer();
    const access = await newRunAccess('app');
    const mine = { ...access, runId: RUN };
    await saveRunRecord(mine, run);
    const stored = server.stored()!;
    expect(isEncryptedRunFile(stored)).toBe(true);
    expect(new TextDecoder().decode(stored)).not.toContain('Informe anual');
    expect(await loadRunRecord(mine)).toEqual(run);

    // Another device's key is named as the reason, before any download.
    vi.mocked(loadMasterKey).mockResolvedValue(OTHER_MASTER);
    server.fetchMock.mockClear();
    await expect(loadRunRecord(mine)).rejects.toBeInstanceOf(RunLockedError);
    expect(server.fetchMock).not.toHaveBeenCalled();
  });

  it('reports a run whose record is gone', async () => {
    recordServer();
    await expect(
      loadRunRecord({ runId: RUN, backend: 'app' }),
    ).rejects.toBeInstanceOf(RunMissingError);
  });
});

describe('files', () => {
  it('lists every file a run still uses, once', () => {
    expect(runFilesInUse(run).sort()).toEqual([
      id('a', 'pdf'),
      id('b', 'json'),
      id('c', 'pdf'),
      id('d', 'png'),
      id('e', 'png'),
    ]);
    expect(runFilesInUse(run)).not.toContain(RUN_RECORD_ID);
  });

  it('refuses a path that is not a run file', async () => {
    await expect(fetchRunFile('/api/file/abc.pdf')).rejects.toThrow(
      'Not a file of a translation run',
    );
  });

  it('passes the server refusal on with its code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Sign in to Microsoft 365', code: 'M365_NOT_CONNECTED' },
          { status: 401 },
        ),
      ),
    );
    const error = await syncRun({ runId: RUN, backend: 'onedrive' }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RunRequestError);
    expect(isOneDriveUnavailable(error)).toBe(true);
    expect(isOneDriveUnavailable(new RunMissingError())).toBe(false);
  });

  it('asks only for the expiry when told not to touch', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        success: true,
        data: { expiresAt: '2026-11-20T00:00:00Z', files: 4 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await syncRun({ runId: RUN, backend: 'app' }, ['x'], false);
    expect(result).toEqual({ expiresAt: '2026-11-20T00:00:00Z' });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      runId: RUN,
      storage: 'app',
      keep: ['x'],
      touch: false,
    });
  });
});
