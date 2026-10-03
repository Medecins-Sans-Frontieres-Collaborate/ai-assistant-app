import { downloadBlob, uploadJson } from '@/lib/services/agentAccess/blobCas';
import { setPayloadCacheForTests } from '@/lib/services/agentAccess/payloadCache';
import {
  AnalyticsBusyError,
  __resetHeavyWorkForTests,
  runHeavy,
} from '@/lib/services/analytics/heavyWork';
import {
  deletePreview,
  readPreview,
  writePreview,
} from '@/lib/services/analytics/previewStore';
import { DerivedTable } from '@/lib/services/analytics/tables';
import { analyticsPreviewPath } from '@/lib/services/analytics/types';

import { installBlobFake } from '../../../app/api/admin/blobFake';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/agentAccess/blobCas', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/agentAccess/blobCas')>();
  return { ...actual, downloadBlob: vi.fn(), uploadJson: vi.fn() };
});

const TABLES: DerivedTable[] = [
  {
    name: 'Daily',
    layout: 'table',
    columns: [
      { name: 'date', kind: 'date' },
      { name: 'unique_users', kind: 'number' },
    ],
    rows: [['2026-07-01', 73]],
    rowCount: 1,
    truncated: false,
    rowLevel: false,
    declaredFields: [],
  },
];
const FILE_ID = 'a'.repeat(32);
const deleted: string[] = [];
const storage = {
  deleteIfExists: async (path: string) => {
    deleted.push(path);
    return true;
  },
} as never;

describe('preview store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installBlobFake();
    setPayloadCacheForTests(null);
    deleted.length = 0;
  });

  it('round-trips the tables, compressed', async () => {
    await writePreview(storage, FILE_ID, '10:v1', TABLES);
    const stored = vi.mocked(uploadJson).mock.calls[0][2] as { data: string };
    expect(stored.data).not.toContain('unique_users');
    expect(await readPreview(storage, FILE_ID, '10:v1')).toEqual(TABLES);
  });

  it('never serves a preview read from an older delivery at the same path', async () => {
    await writePreview(storage, FILE_ID, '10:v1', TABLES);
    expect(await readPreview(storage, FILE_ID, '12:v2')).toBeNull();
  });

  it('returns null when there is none', async () => {
    expect(await readPreview(storage, FILE_ID, '10:v1')).toBeNull();
  });

  it('serves a repeat read from memory', async () => {
    await writePreview(storage, FILE_ID, '10:v1', TABLES);
    await readPreview(storage, FILE_ID, '10:v1');
    await readPreview(storage, FILE_ID, '10:v1');
    expect(vi.mocked(downloadBlob)).toHaveBeenCalledTimes(1);
  });

  it('drops the cached copy when the preview is rewritten or deleted', async () => {
    await writePreview(storage, FILE_ID, '10:v1', TABLES);
    await readPreview(storage, FILE_ID, '10:v1');
    await deletePreview(storage, FILE_ID);
    expect(deleted).toEqual([analyticsPreviewPath(FILE_ID)]);
    await readPreview(storage, FILE_ID, '10:v1');
    expect(vi.mocked(downloadBlob)).toHaveBeenCalledTimes(2);
  });
});

describe('runHeavy', () => {
  beforeEach(() => __resetHeavyWorkForTests());

  it('runs one piece of work at a time, in order', async () => {
    const events: string[] = [];
    const job = (name: string, ms: number) =>
      runHeavy(async () => {
        events.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`end ${name}`);
        return name;
      });
    const results = await Promise.all([job('a', 20), job('b', 1), job('c', 1)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(events).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c',
    ]);
  });

  it('keeps going after a failure', async () => {
    await expect(
      runHeavy(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await runHeavy(async () => 'next')).toBe('next');
  });

  it('refuses a user-facing request when the queue is already long', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runHeavy(() => gate);
    const queued = [1, 2].map(() => runHeavy(async () => undefined));
    await expect(
      runHeavy(async () => 'never', { shed: true }),
    ).rejects.toBeInstanceOf(AnalyticsBusyError);
    // Background work is never shed: it waits its turn.
    const background = runHeavy(async () => 'background');
    release();
    await Promise.all([running, ...queued]);
    expect(await background).toBe('background');
  });
});
