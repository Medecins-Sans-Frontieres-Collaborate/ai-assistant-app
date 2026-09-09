/**
 * Pure job helpers: summaries, staleness, claim bookkeeping, and the
 * end-of-run chunk diff that decides what leaves the search index.
 */
import type {
  M365IndexJob,
  M365ManifestItem,
} from '@/lib/services/agentAccess/types';
import {
  STALE_INDEX_JOB_MS,
  chunkRetentionFor,
  isStaleIndexJob,
  jobSourcesToManifest,
  pendingIndexItems,
  releaseProcessingItems,
  selectStaleChunkIds,
  summarizeIndexJob,
} from '@/lib/services/m365/agentIndexJobStore';

import { describe, expect, it } from 'vitest';

const T0 = Date.parse('2026-08-25T10:00:00.000Z');

function item(
  itemId: string,
  overrides: Partial<M365ManifestItem> = {},
): M365ManifestItem {
  return {
    itemId,
    driveId: 'd',
    name: `${itemId}.pdf`,
    path: '',
    parentItemId: 'root',
    size: 1,
    webUrl: '',
    tier: 'indexable',
    status: 'pending',
    ...overrides,
  };
}

function job(overrides: Partial<M365IndexJob> = {}): M365IndexJob {
  return {
    version: 1,
    jobId: 'job-abcdefabcdef',
    agentId: 'm365-aaaaaaaaaaaa',
    status: 'running',
    startedBy: 'admin@example.org',
    startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    embeddingDeployment: 'text-embedding',
    sources: [
      {
        sourceId: 'src-1',
        status: 'pending',
        truncated: false,
        folders: [],
        items: [
          item('a', { status: 'indexed', indexedChunks: 2 }),
          item('b', { status: 'failed', error: 'boom' }),
          item('c'),
          item('d', { status: 'processing' }),
          item('img', { tier: 'needsPreparation', status: undefined }),
          item('e', { status: 'noText', indexedChunks: 0 }),
        ],
      },
      {
        sourceId: 'src-2',
        status: 'error',
        error: 'listing failed',
        truncated: false,
        folders: [],
        items: [],
      },
    ],
    ...overrides,
  };
}

describe('summarizeIndexJob', () => {
  it('counts indexable items only and marks stale running jobs', () => {
    const summary = summarizeIndexJob(job(), T0 + 1000);
    expect(summary).toMatchObject({
      status: 'running',
      stale: false,
      total: 5,
      done: 3,
      indexed: 1,
      failed: 1,
      noText: 1,
      missing: 0,
    });
    expect(isStaleIndexJob(job(), T0 + STALE_INDEX_JOB_MS + 1)).toBe(true);
    expect(
      isStaleIndexJob(
        job({ status: 'succeeded' }),
        T0 + STALE_INDEX_JOB_MS * 2,
      ),
    ).toBe(false);
  });
});

describe('claim bookkeeping', () => {
  it('lists pending indexable items of pending sources only', () => {
    expect(pendingIndexItems(job())).toEqual([
      { sourceId: 'src-1', itemId: 'c' },
    ]);
  });

  it('releases processing items back to pending on resume', () => {
    const released = releaseProcessingItems(job());
    const statuses = released.sources[0].items.map((i) => i.status);
    expect(statuses).toEqual([
      'indexed',
      'failed',
      'pending',
      'pending',
      undefined,
      'noText',
    ]);
    expect(pendingIndexItems(released).map((p) => p.itemId)).toEqual([
      'c',
      'd',
    ]);
  });

  it('never writes processing into the manifest', () => {
    const manifest = jobSourcesToManifest(job().sources);
    expect(manifest[0].items.find((i) => i.itemId === 'd')?.status).toBe(
      'pending',
    );
  });
});

describe('chunk diff', () => {
  const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_=-]/g, '');

  it('keeps expected chunks, failed items’ old chunks and errored sources; drops the rest', () => {
    const retention = chunkRetentionFor(job(), sanitize);
    const existing = [
      'm365-aaaaaaaaaaaa_src-1_a_0',
      'm365-aaaaaaaaaaaa_src-1_a_1',
      'm365-aaaaaaaaaaaa_src-1_a_2', // shrank: index ≥ new count
      'm365-aaaaaaaaaaaa_src-1_b_0', // failed this run → keep previous
      'm365-aaaaaaaaaaaa_src-1_e_0', // now noText → drop
      'm365-aaaaaaaaaaaa_src-1_gone_0', // left the plan → drop
      'm365-aaaaaaaaaaaa_src-2_x_0', // source plan failed → keep
      'm365-aaaaaaaaaaaa_src-9_y_0', // removed source → drop
    ];
    expect(selectStaleChunkIds(existing, retention)).toEqual([
      'm365-aaaaaaaaaaaa_src-1_a_2',
      'm365-aaaaaaaaaaaa_src-1_e_0',
      'm365-aaaaaaaaaaaa_src-1_gone_0',
      'm365-aaaaaaaaaaaa_src-9_y_0',
    ]);
  });

  it('does not let an item id prefix-match a longer item id', () => {
    const j = job({
      sources: [
        {
          sourceId: 'src-1',
          status: 'pending',
          truncated: false,
          folders: [],
          items: [item('ab', { status: 'failed' })],
        },
      ],
    });
    const retention = chunkRetentionFor(j, sanitize);
    // "ab_" keeps ab's chunks but not "abc"'s.
    expect(
      selectStaleChunkIds(
        ['m365-aaaaaaaaaaaa_src-1_ab_0', 'm365-aaaaaaaaaaaa_src-1_abc_0'],
        retention,
      ),
    ).toEqual(['m365-aaaaaaaaaaaa_src-1_abc_0']);
  });
});
