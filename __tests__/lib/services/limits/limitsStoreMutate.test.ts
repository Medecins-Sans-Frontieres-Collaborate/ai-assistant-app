/**
 * `mutatePolicy` — the scoped write path's bounded read-modify-write under
 * CAS (design §5) — plus the scoped history path. Storage is faked at the
 * block-blob-client level, as usageStore.test.ts does, so every assertion is
 * about the real conditions sent to Azure.
 */
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import {
  LimitsConflictError,
  mutatePolicy,
  writeHistoryEntry,
} from '@/lib/services/limits/limitsStore';
import {
  LIMITS_HISTORY_PREFIX,
  LIMITS_POLICY_PATH,
  LimitsHistoryEntrySchema,
  LimitsPolicy,
  historyBlobPath,
  scopedHistoryBlobPath,
} from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createMockClient() {
  return {
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
  };
}
type MockClient = ReturnType<typeof createMockClient>;

function createMockStorage(client: MockClient) {
  return {
    getBlockBlobClient: vi.fn(() => client),
    listBlobs: vi.fn(),
    upload: vi.fn(),
  } as unknown as BlobStorage & {
    upload: ReturnType<typeof vi.fn>;
    getBlockBlobClient: ReturnType<typeof vi.fn>;
  };
}

function storedPolicy(extra: Partial<LimitsPolicy> = {}): LimitsPolicy {
  return {
    version: 1,
    defaults: [],
    overrides: [],
    delegations: [],
    mode: 'observe',
    failMode: 'open',
    timezone: 'UTC',
    countByomUsage: false,
    countAuxiliaryUsage: false,
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function downloadOf(body: unknown, etag: string) {
  return {
    etag,
    readableStreamBody: Readable.from([
      Buffer.from(
        typeof body === 'string' ? body : JSON.stringify(body),
        'utf8',
      ),
    ]),
  };
}

function notFound() {
  return Object.assign(new Error('not found'), { statusCode: 404 });
}

function preconditionFailed() {
  return Object.assign(new Error('precondition failed'), { statusCode: 412 });
}

function forbidden() {
  return Object.assign(new Error('forbidden'), { statusCode: 403 });
}

const FAST = { backoffMs: 0 };

describe('mutatePolicy', () => {
  let client: MockClient;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    client = createMockClient();
    storage = createMockStorage(client);
  });

  it('creates the document (If-None-Match: *) when none is stored, handing the mutator (null, null)', async () => {
    client.download.mockRejectedValue(notFound());
    client.upload.mockResolvedValue({ etag: '"etag-1"' });
    const mutate = vi.fn(() => storedPolicy({ updatedBy: 'scoped@x.org' }));

    const result = await mutatePolicy(storage, mutate, FAST);

    expect(mutate).toHaveBeenCalledWith(null, null);
    expect(storage.getBlockBlobClient).toHaveBeenCalledWith(LIMITS_POLICY_PATH);
    expect(client.upload).toHaveBeenCalledTimes(1);
    expect(client.upload.mock.calls[0][2].conditions).toEqual({
      ifNoneMatch: '*',
    });
    expect(result.abort).toBeUndefined();
    expect(result.etag).toBe('"etag-1"');
    expect(result.policy?.updatedBy).toBe('scoped@x.org');
  });

  it('writes with If-Match of the etag it read, and returns the PARSED document', async () => {
    // Stored blob predates delegations: the read must default it.
    const { delegations: _omit, ...legacy } = storedPolicy();
    void _omit;
    client.download.mockImplementation(() => downloadOf(legacy, '"etag-a"'));
    client.upload.mockResolvedValue({ etag: '"etag-b"' });

    const result = await mutatePolicy(
      storage,
      (current, etag) => {
        expect(current?.delegations).toEqual([]);
        expect(etag).toBe('"etag-a"');
        return { ...current!, timezone: 'Europe/Paris' };
      },
      FAST,
    );

    expect(client.upload.mock.calls[0][2].conditions).toEqual({
      ifMatch: '"etag-a"',
    });
    expect(result).toMatchObject({
      etag: '"etag-b"',
      policy: { timezone: 'Europe/Paris', delegations: [] },
    });
  });

  it('re-reads and re-invokes the mutator with the FRESH document after a 412', async () => {
    client.download
      .mockResolvedValueOnce(
        downloadOf(storedPolicy({ timezone: 'UTC' }), '"etag-1"'),
      )
      .mockResolvedValueOnce(
        downloadOf(storedPolicy({ timezone: 'Asia/Tokyo' }), '"etag-2"'),
      );
    client.upload
      .mockRejectedValueOnce(preconditionFailed())
      .mockResolvedValueOnce({ etag: '"etag-3"' });
    const seen: Array<[string, string | null]> = [];
    const mutate = vi.fn(
      (current: LimitsPolicy | null, etag: string | null) => {
        seen.push([current!.timezone, etag]);
        return { ...current!, mode: 'enforce' as const };
      },
    );

    const result = await mutatePolicy(storage, mutate, FAST);

    expect(seen).toEqual([
      ['UTC', '"etag-1"'],
      ['Asia/Tokyo', '"etag-2"'],
    ]);
    expect(client.upload).toHaveBeenCalledTimes(2);
    expect(client.upload.mock.calls[1][2].conditions).toEqual({
      ifMatch: '"etag-2"',
    });
    expect(result.policy?.timezone).toBe('Asia/Tokyo');
    expect(result.etag).toBe('"etag-3"');
  });

  it('throws LimitsConflictError after the bounded number of 412s (default 3)', async () => {
    client.download.mockImplementation(() => downloadOf(storedPolicy(), '"e"'));
    client.upload.mockRejectedValue(preconditionFailed());
    const mutate = vi.fn((current: LimitsPolicy | null) => current!);

    await expect(mutatePolicy(storage, mutate, FAST)).rejects.toBeInstanceOf(
      LimitsConflictError,
    );
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(client.upload).toHaveBeenCalledTimes(3);
    expect(LimitsConflictError).toBe(AgentAccessConflictError);
  });

  it('honours `attempts`', async () => {
    client.download.mockImplementation(() => downloadOf(storedPolicy(), '"e"'));
    client.upload.mockRejectedValue(preconditionFailed());
    const mutate = vi.fn((current: LimitsPolicy | null) => current!);

    await expect(
      mutatePolicy(storage, mutate, { ...FAST, attempts: 1 }),
    ).rejects.toBeInstanceOf(LimitsConflictError);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('an { abort } outcome stops without writing and is handed back verbatim', async () => {
    client.download.mockImplementation(() => downloadOf(storedPolicy(), '"e"'));
    const response = new Response('nope', { status: 403 });
    const mutate = vi.fn(() => ({ abort: response }));

    const result = await mutatePolicy(storage, mutate, FAST);

    expect(result.abort).toBe(response);
    expect(result.policy).toBeUndefined();
    expect(client.upload).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('a non-conflict write failure propagates without retry', async () => {
    client.download.mockImplementation(() => downloadOf(storedPolicy(), '"e"'));
    client.upload.mockRejectedValue(forbidden());
    const mutate = vi.fn((current: LimitsPolicy | null) => current!);

    await expect(mutatePolicy(storage, mutate, FAST)).rejects.toThrow(
      'forbidden',
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(client.upload).toHaveBeenCalledTimes(1);
  });

  it('a corrupt stored document fails loud before the mutator runs (single-document posture)', async () => {
    client.download.mockImplementation(() => downloadOf('{not json', '"e"'));
    const mutate = vi.fn((current: LimitsPolicy | null) => current!);

    await expect(mutatePolicy(storage, mutate, FAST)).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('rejects a mutator result that violates the read schema instead of storing it', async () => {
    client.download.mockImplementation(() => downloadOf(storedPolicy(), '"e"'));
    const mutate = vi.fn(
      (current: LimitsPolicy | null) =>
        ({ ...current!, mode: 'yolo' }) as unknown as LimitsPolicy,
    );

    await expect(mutatePolicy(storage, mutate, FAST)).rejects.toThrow();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('NEVER calls AzureBlobStorage.upload (the same-length dedupe trap)', async () => {
    client.download.mockImplementation(() => downloadOf(storedPolicy(), '"e"'));
    client.upload.mockResolvedValue({ etag: '"f"' });
    await mutatePolicy(storage, (current) => current!, FAST);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

describe('scoped history', () => {
  it('scopedHistoryBlobPath differs per override id and stays under the history prefix', () => {
    const ts = '2026-09-04T10:00:00.000Z';
    const a = scopedHistoryBlobPath(ts, 'ocp@example.org', 'lim-0000000000a1');
    const b = scopedHistoryBlobPath(ts, 'ocp@example.org', 'lim-0000000000a2');
    expect(a).not.toBe(b);
    expect(a.startsWith(LIMITS_HISTORY_PREFIX)).toBe(true);
    expect(a).not.toBe(historyBlobPath(ts, 'ocp@example.org'));
    expect(a).not.toMatch(/[^0-9A-Za-z./@_-]/);
    // Hostile override id cannot escape the path.
    expect(
      scopedHistoryBlobPath(ts, 'ocp@example.org', '../../etc/passwd'),
    ).not.toContain('..');
  });

  it('the history schema accepts scoped actions with delegation/override ids', () => {
    const parsed = LimitsHistoryEntrySchema.parse({
      version: 1,
      action: 'scoped-delete',
      policy: null,
      updatedBy: 'ocp@example.org',
      updatedAt: '2026-09-04T10:00:00.000Z',
      delegationId: 'del-0123456789ab',
      overrideId: 'lim-0123456789ab',
    });
    expect(parsed.action).toBe('scoped-delete');
    expect(() =>
      LimitsHistoryEntrySchema.parse({ ...parsed, action: 'delete' }),
    ).toThrow();
  });

  it('writeHistoryEntry uses the per-override path for entries that name an overrideId', async () => {
    const client = createMockClient();
    const storage = createMockStorage(client);
    client.upload.mockResolvedValue({ etag: '"h"' });
    const ts = '2026-09-04T10:00:00.000Z';

    await writeHistoryEntry(storage, {
      version: 1,
      action: 'scoped-upsert',
      policy: null,
      updatedBy: 'ocp@example.org',
      updatedAt: ts,
      delegationId: 'del-0123456789ab',
      overrideId: 'lim-0123456789ab',
    });
    await writeHistoryEntry(storage, {
      version: 1,
      action: 'upsert',
      policy: null,
      updatedBy: 'ocp@example.org',
      updatedAt: ts,
    });

    expect(storage.getBlockBlobClient).toHaveBeenNthCalledWith(
      1,
      scopedHistoryBlobPath(ts, 'ocp@example.org', 'lim-0123456789ab'),
    );
    expect(storage.getBlockBlobClient).toHaveBeenNthCalledWith(
      2,
      historyBlobPath(ts, 'ocp@example.org'),
    );
  });
});
