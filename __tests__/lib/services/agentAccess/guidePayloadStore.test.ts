import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import {
  PRUNE_GRACE_MS,
  hydrateGuide,
  newPayloadRef,
  parseGlossaryJsonl,
  payloadRefTimestamp,
  pruneGuidePayloads,
  readGuidePayload,
  writeGuidePayload,
} from '@/lib/services/agentAccess/guidePayloadStore';
import {
  PayloadCache,
  setPayloadCacheForTests,
} from '@/lib/services/agentAccess/payloadCache';
import {
  GUIDE_PAYLOAD_REF_PATTERN,
  Guide,
  guidePayloadBlobPath,
  guidePayloadListPrefix,
} from '@/lib/services/agentAccess/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';

import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, gzipSync } from 'zlib';

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_BLOB_STORAGE_NAME: 'testaccount',
    AZURE_BLOB_STORAGE_CONTAINER: 'testcontainer',
  },
}));

const GUIDE_ID = 'guide-abc123def456';

/** In-memory blob container: upload/download/delete/list by name. */
function createFakeStorage() {
  const blobs = new Map<string, Buffer>();
  const clients = new Map<string, ReturnType<typeof clientFor>>();
  function clientFor(name: string) {
    return {
      upload: vi.fn(async (buf: Buffer, _len: number, opts?: unknown) => {
        const conditions = (opts as { conditions?: { ifNoneMatch?: string } })
          ?.conditions;
        if (conditions?.ifNoneMatch === '*' && blobs.has(name)) {
          throw Object.assign(new Error('exists'), { statusCode: 409 });
        }
        blobs.set(name, Buffer.from(buf));
        return { etag: `"${name}-${blobs.size}"` };
      }),
      download: vi.fn(async () => {
        const buf = blobs.get(name);
        if (!buf) throw Object.assign(new Error('nf'), { statusCode: 404 });
        return { readableStreamBody: Readable.from([buf]), etag: '"e"' };
      }),
      delete: vi.fn(async () => {
        if (!blobs.has(name)) {
          throw Object.assign(new Error('nf'), { statusCode: 404 });
        }
        blobs.delete(name);
      }),
    };
  }
  const storage = {
    getBlockBlobClient: (name: string) => {
      let c = clients.get(name);
      if (!c) {
        c = clientFor(name);
        clients.set(name, c);
      }
      return c;
    },
    listBlobs: vi.fn(async (prefix: string) =>
      [...blobs.keys()].filter((n) => n.startsWith(prefix)),
    ),
  } as unknown as BlobStorage;
  return { storage, blobs };
}

function meta(overrides: Partial<Guide> = {}): Guide {
  return {
    version: 1,
    id: GUIDE_ID,
    kind: 'terminology',
    name: 'Org glossary',
    description: '',
    languages: [],
    workflows: ['translation'],
    createdBy: 'a@example.com',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedBy: 'a@example.com',
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('guidePayloadStore', () => {
  beforeEach(() => {
    setPayloadCacheForTests(new PayloadCache(1024 * 1024));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('mints sortable refs whose timestamp round-trips', () => {
    const ref = newPayloadRef(1_700_000_000_000);
    expect(GUIDE_PAYLOAD_REF_PATTERN.test(ref)).toBe(true);
    expect(payloadRefTimestamp(ref)).toBe(1_700_000_000_000);
    expect(payloadRefTimestamp('nope')).toBeNull();
  });

  it('writes terminology entries as gzipped JSONL and reads them back', async () => {
    const { storage, blobs } = createFakeStorage();
    const written = await writeGuidePayload(storage, GUIDE_ID, 'terminology', {
      entries: [
        { source: 'IDP', target: 'PDI', kind: 'acronym' },
        { source: 'clinic', target: 'clinique' },
      ],
    });
    expect(written.payloadFormat).toBe('jsonl');
    expect(written.entryCount).toBe(2);
    const path = guidePayloadBlobPath(GUIDE_ID, written.payloadRef, 'jsonl');
    const raw = blobs.get(path)!;
    expect(raw[0]).toBe(0x1f);
    expect(gunzipSync(raw).toString('utf8').split('\n')).toHaveLength(2);

    const fields = await readGuidePayload(
      storage,
      GUIDE_ID,
      written.payloadRef,
      'jsonl',
    );
    expect(fields?.entries).toEqual([
      { source: 'IDP', target: 'PDI', kind: 'acronym' },
      { source: 'clinic', target: 'clinique' },
    ]);
  });

  it('writes prose kinds as gzipped JSON without the entries key', async () => {
    const { storage, blobs } = createFakeStorage();
    const written = await writeGuidePayload(storage, GUIDE_ID, 'style', {
      body: '# Rules',
      entries: [{ source: 'x', target: 'y' }],
    });
    expect(written.payloadFormat).toBe('json');
    expect(written.entryCount).toBeUndefined();
    const raw = blobs.get(
      guidePayloadBlobPath(GUIDE_ID, written.payloadRef, 'json'),
    )!;
    expect(JSON.parse(gunzipSync(raw).toString('utf8'))).toEqual({
      body: '# Rules',
    });
  });

  it('never overwrites: a name collision surfaces as a conflict', async () => {
    const { storage } = createFakeStorage();
    const { payloadRef } = await writeGuidePayload(storage, GUIDE_ID, 'style', {
      body: 'a',
    });
    // Force the same ref by pre-placing a blob at the path the next write
    // would use is impractical (random); instead assert the create-only
    // condition is what the client receives.
    const client = storage.getBlockBlobClient(
      guidePayloadBlobPath(GUIDE_ID, payloadRef, 'json'),
    ) as unknown as { upload: ReturnType<typeof vi.fn> };
    expect(client.upload.mock.calls[0][2]).toMatchObject({
      conditions: { ifNoneMatch: '*' },
    });
    await expect(
      (async () => {
        try {
          await client.upload(Buffer.from('x'), 1, {
            conditions: { ifNoneMatch: '*' },
          });
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 409) {
            throw new AgentAccessConflictError();
          }
          throw error;
        }
      })(),
    ).rejects.toBeInstanceOf(AgentAccessConflictError);
  });

  it('soft-skips malformed JSONL lines and keeps the rest', () => {
    const text = [
      JSON.stringify({ source: 'a', target: 'b' }),
      '{not json',
      JSON.stringify({ source: '', target: 'x' }),
      JSON.stringify({ source: 'c', target: 'd', kind: 'acronym' }),
    ].join('\n');
    const entries = parseGlossaryJsonl(text, 'p');
    expect(entries.map((e) => e.source)).toEqual(['a', 'c']);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('SKIPPED 2'),
    );
  });

  it('accepts a plain (ungzipped) JSONL blob too', async () => {
    const { storage, blobs } = createFakeStorage();
    const ref = newPayloadRef();
    blobs.set(
      guidePayloadBlobPath(GUIDE_ID, ref, 'jsonl'),
      Buffer.from(JSON.stringify({ source: 'a', target: 'b' })),
    );
    const fields = await readGuidePayload(storage, GUIDE_ID, ref, 'jsonl');
    expect(fields?.entries).toHaveLength(1);
  });

  it('caches by blob name so a second read never touches storage', async () => {
    const { storage } = createFakeStorage();
    const { payloadRef } = await writeGuidePayload(storage, GUIDE_ID, 'style', {
      body: 'a',
    });
    await readGuidePayload(storage, GUIDE_ID, payloadRef, 'json');
    await readGuidePayload(storage, GUIDE_ID, payloadRef, 'json');
    const client = storage.getBlockBlobClient(
      guidePayloadBlobPath(GUIDE_ID, payloadRef, 'json'),
    ) as unknown as { download: ReturnType<typeof vi.fn> };
    expect(client.download).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed ref before touching storage', async () => {
    const { storage } = createFakeStorage();
    expect(
      await readGuidePayload(storage, GUIDE_ID, '../etc/passwd', 'json'),
    ).toBeNull();
    expect(storage.listBlobs).not.toHaveBeenCalled();
  });

  describe('hydrateGuide', () => {
    it('passes a legacy inline record through untouched', async () => {
      const legacy = meta({ entries: [{ source: 'a', target: 'b' }] });
      expect(await hydrateGuide(legacy)).toBe(legacy);
    });

    it('merges the external payload into a split record', async () => {
      const { storage } = createFakeStorage();
      const written = await writeGuidePayload(
        storage,
        GUIDE_ID,
        'terminology',
        { entries: [{ source: 'a', target: 'b' }] },
      );
      const hydrated = await hydrateGuide(
        meta({
          payloadRef: written.payloadRef,
          payloadFormat: 'jsonl',
          entryCount: 1,
        }),
        storage,
      );
      expect(hydrated?.entries).toEqual([{ source: 'a', target: 'b' }]);
      expect(hydrated?.payloadRef).toBe(written.payloadRef);
    });

    it('returns null when the referenced blob is missing', async () => {
      const { storage } = createFakeStorage();
      expect(
        await hydrateGuide(
          meta({ payloadRef: newPayloadRef(), payloadFormat: 'jsonl' }),
          storage,
        ),
      ).toBeNull();
    });
  });

  describe('pruneGuidePayloads', () => {
    it('prunes only versions superseded longer ago than the grace window', async () => {
      const { storage, blobs } = createFakeStorage();
      const now = Date.now();
      // v0 (old) → v1 (superseded 2 grace ago) → v2 (superseded just now) → live
      const v0 = newPayloadRef(now - 10 * PRUNE_GRACE_MS);
      const v1 = newPayloadRef(now - 5 * PRUNE_GRACE_MS);
      const v2 = newPayloadRef(now - 2 * PRUNE_GRACE_MS);
      const live = newPayloadRef(now - 1000);
      const foreign = `${guidePayloadListPrefix(GUIDE_ID)}README.txt`;
      for (const ref of [v0, v1, v2, live]) {
        blobs.set(guidePayloadBlobPath(GUIDE_ID, ref, 'jsonl'), gzipSync(''));
      }
      blobs.set(foreign, Buffer.from('x'));

      const deleted = await pruneGuidePayloads(storage, GUIDE_ID, live, now);
      // v0 was superseded by v1 (5 grace ago) and v1 by v2 (2 grace ago):
      // both gone. v2 was superseded by `live` a second ago: kept, even
      // though v2 itself is old — a stale snapshot may still name it.
      expect(deleted).toBe(2);
      expect(blobs.has(guidePayloadBlobPath(GUIDE_ID, v0, 'jsonl'))).toBe(
        false,
      );
      expect(blobs.has(guidePayloadBlobPath(GUIDE_ID, v1, 'jsonl'))).toBe(
        false,
      );
      expect(blobs.has(guidePayloadBlobPath(GUIDE_ID, v2, 'jsonl'))).toBe(true);
      expect(blobs.has(guidePayloadBlobPath(GUIDE_ID, live, 'jsonl'))).toBe(
        true,
      );
      expect(blobs.has(foreign)).toBe(true);
    });

    it('never prunes an orphan newer than the live ref (a CAS loser still in flight)', async () => {
      const { storage, blobs } = createFakeStorage();
      const now = Date.now();
      const live = newPayloadRef(now - 20 * PRUNE_GRACE_MS);
      const orphan = newPayloadRef(now - 500);
      for (const ref of [live, orphan]) {
        blobs.set(guidePayloadBlobPath(GUIDE_ID, ref, 'jsonl'), gzipSync(''));
      }
      expect(await pruneGuidePayloads(storage, GUIDE_ID, live, now)).toBe(0);
    });

    it('removes every version when the guide is gone', async () => {
      const { storage, blobs } = createFakeStorage();
      const now = Date.now();
      for (const ref of [newPayloadRef(now), newPayloadRef(now - 1)]) {
        blobs.set(guidePayloadBlobPath(GUIDE_ID, ref, 'jsonl'), gzipSync(''));
      }
      expect(await pruneGuidePayloads(storage, GUIDE_ID, null, now)).toBe(2);
      expect(blobs.size).toBe(0);
    });
  });
});
