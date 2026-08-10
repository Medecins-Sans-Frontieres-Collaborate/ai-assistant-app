import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import { UsageDoc } from '@/lib/services/limits/types';
import {
  CounterRequest,
  readUsage,
  release,
  reserve,
  usageBlobPath,
} from '@/lib/services/limits/usageStore';

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

/**
 * `upload` is stubbed on the storage itself so every test proves writes go
 * through getBlockBlobClient().upload and NEVER AzureBlobStorage.upload() —
 * whose same-byte-length dedupe would silently drop `{"…":41}` → `{"…":42}`.
 */
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

function downloadOf(doc: Partial<UsageDoc>, etag = '"etag-1"') {
  const full: UsageDoc = {
    version: 1,
    subjectId: 'oid-1',
    periodKind: 'day',
    period: '2026-07-24',
    counters: {},
    updatedAt: '2026-07-24T00:00:00.000Z',
    ...doc,
  } as UsageDoc;
  return {
    etag,
    readableStreamBody: Readable.from([
      Buffer.from(JSON.stringify(full), 'utf8'),
    ]),
  };
}

function notFound() {
  return Object.assign(new Error('not found'), { statusCode: 404 });
}

function preconditionFailed() {
  return Object.assign(new Error('precondition failed'), { statusCode: 412 });
}

const NOW = new Date('2026-07-24T12:00:00.000Z');

function counter(overrides: Partial<CounterRequest> = {}): CounterRequest {
  return {
    cell: 'chat.messagesPerDay',
    cost: 1,
    limit: 10,
    limitKey: 'chat.messagesPerDay',
    ...overrides,
  };
}

describe('usageBlobPath', () => {
  it('shards by a hash prefix and never interpolates the raw subject id', () => {
    const path = usageBlobPath('oid-1', 'day', '2026-07-24');
    expect(path).toMatch(
      /^system\/limits\/usage\/day\/2026-07-24\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/,
    );
    expect(path).not.toContain('oid-1');
  });

  it('is stable for the same subject and period', () => {
    expect(usageBlobPath('oid-1', 'day', '2026-07-24')).toBe(
      usageBlobPath('oid-1', 'day', '2026-07-24'),
    );
  });
});

describe('reserve', () => {
  let client: MockClient;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
    storage = createMockStorage(client);
  });

  it('touches storage ZERO times when nothing is metered', async () => {
    const result = await reserve('oid-1', 'day', [], { storage, now: NOW });
    expect(result.allowed).toBe(true);
    expect(storage.getBlockBlobClient).not.toHaveBeenCalled();
  });

  it('creates a fresh document with If-None-Match when none exists', async () => {
    client.download.mockRejectedValue(notFound());
    client.upload.mockResolvedValue({ etag: '"new"' });

    const result = await reserve('oid-1', 'day', [counter()], {
      storage,
      now: NOW,
    });

    expect(result.allowed).toBe(true);
    expect(client.upload).toHaveBeenCalledTimes(1);
    const [, , options] = client.upload.mock.calls[0];
    expect(options.conditions).toEqual({ ifNoneMatch: '*' });
    const written = JSON.parse(client.upload.mock.calls[0][0].toString('utf8'));
    expect(written.counters['chat.messagesPerDay']).toBe(1);
  });

  it('NEVER calls AzureBlobStorage.upload (the dedupe trap)', async () => {
    client.download.mockResolvedValue(downloadOf({ counters: { a: 1 } }));
    client.upload.mockResolvedValue({ etag: '"e2"' });
    await reserve('oid-1', 'day', [counter({ cell: 'a', limit: 10 })], {
      storage,
      now: NOW,
    });
    expect(storage.upload).not.toHaveBeenCalled();
    expect(client.upload).toHaveBeenCalled();
  });

  it('increments an existing counter with If-Match', async () => {
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'chat.messagesPerDay': 4 } }, '"etag-7"'),
    );
    client.upload.mockResolvedValue({ etag: '"etag-8"' });

    await reserve('oid-1', 'day', [counter()], { storage, now: NOW });

    const [, , options] = client.upload.mock.calls[0];
    expect(options.conditions).toEqual({ ifMatch: '"etag-7"' });
    const written = JSON.parse(client.upload.mock.calls[0][0].toString('utf8'));
    expect(written.counters['chat.messagesPerDay']).toBe(5);
  });

  it('admits the request at limit-1 and denies exactly AT the limit', async () => {
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'chat.messagesPerDay': 9 } }),
    );
    client.upload.mockResolvedValue({ etag: '"e"' });
    const atBoundary = await reserve('oid-1', 'day', [counter({ limit: 10 })], {
      storage,
      now: NOW,
    });
    expect(atBoundary.allowed).toBe(true);

    vi.clearAllMocks();
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'chat.messagesPerDay': 10 } }),
    );
    const overBoundary = await reserve(
      'oid-1',
      'day',
      [counter({ limit: 10 })],
      { storage, now: NOW },
    );
    expect(overBoundary.allowed).toBe(false);
    expect(overBoundary.denial).toMatchObject({ limit: 10, used: 10 });
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('denies when the COST would cross the limit, not just the current value', async () => {
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'feature.tts.charactersPerDay': 900 } }),
    );
    const result = await reserve(
      'oid-1',
      'day',
      [
        counter({
          cell: 'feature.tts.charactersPerDay',
          limitKey: 'feature.tts.charactersPerDay',
          cost: 200,
          limit: 1000,
        }),
      ],
      { storage, now: NOW },
    );
    expect(result.allowed).toBe(false);
  });

  it('debits multiple cells all-or-nothing in ONE swap', async () => {
    client.download.mockResolvedValue(downloadOf({ counters: {} }));
    client.upload.mockResolvedValue({ etag: '"e"' });

    await reserve(
      'oid-1',
      'day',
      [
        counter(),
        counter({ cell: 'model:gpt-5.2.requests', limitKey: 'model.requests' }),
        counter({ cell: 'family:gpt.requests', limitKey: 'model.requests' }),
      ],
      { storage, now: NOW },
    );

    expect(client.upload).toHaveBeenCalledTimes(1);
    const written = JSON.parse(client.upload.mock.calls[0][0].toString('utf8'));
    expect(written.counters).toEqual({
      'chat.messagesPerDay': 1,
      'model:gpt-5.2.requests': 1,
      'family:gpt.requests': 1,
    });
  });

  it('writes NOTHING when any one cell in the batch would exceed', async () => {
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'family:gpt.requests': 100 } }),
    );
    const result = await reserve(
      'oid-1',
      'day',
      [
        counter({ limit: 1000 }),
        counter({
          cell: 'family:gpt.requests',
          limitKey: 'model.requests',
          limit: 100,
        }),
      ],
      { storage, now: NOW },
    );
    expect(result.allowed).toBe(false);
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('retries on 412 and succeeds against the winner’s value', async () => {
    client.download
      .mockResolvedValueOnce(
        downloadOf({ counters: { 'chat.messagesPerDay': 4 } }, '"old"'),
      )
      .mockResolvedValueOnce(
        downloadOf({ counters: { 'chat.messagesPerDay': 5 } }, '"new"'),
      );
    client.upload
      .mockRejectedValueOnce(preconditionFailed())
      .mockResolvedValueOnce({ etag: '"final"' });

    const result = await reserve('oid-1', 'day', [counter()], {
      storage,
      now: NOW,
    });

    expect(result.allowed).toBe(true);
    expect(client.upload).toHaveBeenCalledTimes(2);
    const written = JSON.parse(client.upload.mock.calls[1][0].toString('utf8'));
    // Re-checked against the winner's 5, not the stale 4.
    expect(written.counters['chat.messagesPerDay']).toBe(6);
  });

  it('re-checks the LIMIT after a lost race and can deny on the retry', async () => {
    client.download
      .mockResolvedValueOnce(
        downloadOf({ counters: { 'chat.messagesPerDay': 9 } }, '"old"'),
      )
      .mockResolvedValueOnce(
        downloadOf({ counters: { 'chat.messagesPerDay': 10 } }, '"new"'),
      );
    client.upload.mockRejectedValueOnce(preconditionFailed());

    const result = await reserve('oid-1', 'day', [counter({ limit: 10 })], {
      storage,
      now: NOW,
    });

    // The other replica took the last slot; this one must NOT also be admitted.
    expect(result.allowed).toBe(false);
  });

  it('rolls the period over lazily when the stored document is stale', async () => {
    client.download.mockResolvedValue(
      downloadOf({
        period: '2026-07-23',
        counters: { 'chat.messagesPerDay': 9 },
      }),
    );
    client.upload.mockResolvedValue({ etag: '"e"' });

    const result = await reserve('oid-1', 'day', [counter({ limit: 10 })], {
      storage,
      now: NOW,
    });

    expect(result.allowed).toBe(true);
    const written = JSON.parse(client.upload.mock.calls[0][0].toString('utf8'));
    expect(written.period).toBe('2026-07-24');
    // Yesterday's 9 must not carry over.
    expect(written.counters['chat.messagesPerDay']).toBe(1);
  });

  it('treats an unparseable document as empty rather than blocking forever', async () => {
    client.download.mockResolvedValue({
      etag: '"e"',
      readableStreamBody: Readable.from([Buffer.from('{"garbage":true}')]),
    });
    client.upload.mockResolvedValue({ etag: '"e2"' });

    const result = await reserve('oid-1', 'day', [counter()], {
      storage,
      now: NOW,
    });
    expect(result.allowed).toBe(true);
  });

  it('fails OPEN when storage is unreachable and failMode is open', async () => {
    client.download.mockRejectedValue(
      Object.assign(new Error('boom'), { statusCode: 503 }),
    );
    const result = await reserve('oid-1', 'day', [counter()], {
      storage,
      now: NOW,
      failMode: 'open',
    });
    expect(result.allowed).toBe(true);
    expect(result.failedOpen).toBe(true);
  });

  it('fails CLOSED when storage is unreachable and failMode is closed', async () => {
    client.download.mockRejectedValue(
      Object.assign(new Error('boom'), { statusCode: 503 }),
    );
    const result = await reserve('oid-1', 'day', [counter()], {
      storage,
      now: NOW,
      failMode: 'closed',
    });
    expect(result.allowed).toBe(false);
    expect(result.denial?.limitKey).toBe('chat.messagesPerDay');
  });

  it('honours failMode after exhausting CAS attempts', async () => {
    // A fresh response per call: a Readable can only be consumed once, so a
    // shared mockResolvedValue would hand attempt 2 an exhausted stream.
    client.download.mockImplementation(async () => downloadOf({}));
    client.upload.mockRejectedValue(preconditionFailed());

    const result = await reserve('oid-1', 'day', [counter()], {
      storage,
      now: NOW,
      failMode: 'open',
    });
    expect(result.allowed).toBe(true);
    expect(result.failedOpen).toBe(true);
    expect(client.upload).toHaveBeenCalledTimes(6);
  }, 10_000);

  it('uses the policy timezone for the period key', async () => {
    client.download.mockRejectedValue(notFound());
    client.upload.mockResolvedValue({ etag: '"e"' });

    await reserve('oid-1', 'day', [counter()], {
      storage,
      // 03:30 UTC is still the previous day in New York.
      now: new Date('2026-07-25T03:30:00.000Z'),
      timezone: 'America/New_York',
    });

    expect(storage.getBlockBlobClient).toHaveBeenCalledWith(
      expect.stringContaining('/day/2026-07-24/'),
    );
  });
});

describe('release', () => {
  let client: MockClient;
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
    storage = createMockStorage(client);
  });

  it('decrements a previously debited cell', async () => {
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'chat.messagesPerDay': 5 } }),
    );
    client.upload.mockResolvedValue({ etag: '"e"' });

    await release('oid-1', 'day', [counter()], { storage, now: NOW });

    const written = JSON.parse(client.upload.mock.calls[0][0].toString('utf8'));
    expect(written.counters['chat.messagesPerDay']).toBe(4);
  });

  it('never drives a counter negative', async () => {
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'chat.messagesPerDay': 0 } }),
    );
    client.upload.mockResolvedValue({ etag: '"e"' });

    await release('oid-1', 'day', [counter({ cost: 5 })], {
      storage,
      now: NOW,
    });

    const written = JSON.parse(client.upload.mock.calls[0][0].toString('utf8'));
    expect(written.counters['chat.messagesPerDay']).toBe(0);
  });

  it('is a no-op when no document exists, and never throws', async () => {
    client.download.mockRejectedValue(notFound());
    await expect(
      release('oid-1', 'day', [counter()], { storage, now: NOW }),
    ).resolves.toBeUndefined();
    expect(client.upload).not.toHaveBeenCalled();
  });

  it('swallows a persistent write failure rather than double-refunding', async () => {
    client.download.mockResolvedValue(downloadOf({ counters: { a: 3 } }));
    client.upload.mockRejectedValue(new Error('storage down'));
    await expect(
      release('oid-1', 'day', [counter({ cell: 'a' })], {
        storage,
        now: NOW,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('readUsage', () => {
  it('returns the stored counters for the current period', async () => {
    const client = createMockClient();
    client.download.mockResolvedValue(
      downloadOf({ counters: { 'chat.messagesPerDay': 3 } }),
    );
    const counters = await readUsage('oid-1', 'day', {
      storage: createMockStorage(client),
      now: NOW,
    });
    expect(counters).toEqual({ 'chat.messagesPerDay': 3 });
  });

  it('returns {} for a stale period rather than yesterday’s numbers', async () => {
    const client = createMockClient();
    client.download.mockResolvedValue(
      downloadOf({ period: '2026-07-01', counters: { a: 99 } }),
    );
    const counters = await readUsage('oid-1', 'day', {
      storage: createMockStorage(client),
      now: NOW,
    });
    expect(counters).toEqual({});
  });

  it('returns {} when no document exists', async () => {
    const client = createMockClient();
    client.download.mockRejectedValue(notFound());
    const counters = await readUsage('oid-1', 'day', {
      storage: createMockStorage(client),
      now: NOW,
    });
    expect(counters).toEqual({});
  });
});

describe('AgentAccessConflictError reuse', () => {
  it('is the error type a 412 surfaces as', () => {
    expect(new AgentAccessConflictError().name).toBe(
      'AgentAccessConflictError',
    );
  });
});
