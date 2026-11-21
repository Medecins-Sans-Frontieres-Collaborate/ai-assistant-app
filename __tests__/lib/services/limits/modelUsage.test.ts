import { subjectHash } from '@/lib/services/limits/decisionStats';
import {
  MODEL_DAY_VERSION,
  ModelDayDoc,
  __resetModelUsageInsightsForTests,
  aggregateOf,
  buildModelDay,
  combineModelDays,
  loadModelUsage,
  modelDayPath,
} from '@/lib/services/limits/modelUsageInsights';
import {
  MAX_SUBJECTS_PER_MODEL,
  ModelUsageDoc,
  OVERFLOW_SUBJECT,
  __resetModelUsageTallyForTests,
  flushModelUsage,
  modelUsageDayPrefix,
  modelUsagePath,
  recordModelUsage,
} from '@/lib/services/limits/modelUsageTally';
import {
  __resetUsageInsightsForTests,
  loadUsageInsights,
} from '@/lib/services/limits/usageInsights';

import { REQUEST_BUCKET_EDGES } from '@/lib/utils/shared/usageDistribution';

import { MemoryBlobStorage, memoryBlobStorage } from './memoryBlobStorage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-model usage for everyone, capped or not: the request path tallies in
 * memory, each replica flushes one file per day, a finished day is merged
 * once, and days merge into what the Models page shows.
 */

const DAY = '2026-07-23';
const NEXT_DAY = '2026-07-24';

let blobs: MemoryBlobStorage;
let clock: Date;
/** While true, reaching storage throws (an outage). */
let storageDown: boolean;

beforeEach(() => {
  blobs = memoryBlobStorage();
  clock = new Date(`${DAY}T15:00:00.000Z`);
  storageDown = false;
  __resetModelUsageTallyForTests({
    storage: () => {
      if (storageDown) throw new Error('storage down');
      return blobs.storage;
    },
    now: () => clock,
  });
  __resetModelUsageInsightsForTests();
  __resetUsageInsightsForTests();
});

afterEach(() => {
  __resetModelUsageTallyForTests();
  vi.restoreAllMocks();
});

async function onlyTally(day: string): Promise<ModelUsageDoc> {
  const files = await blobs.storage.listBlobs(modelUsageDayPrefix(day));
  expect(files).toHaveLength(1);
  return blobs.json(files[0]) as ModelUsageDoc;
}

describe('model usage tally', () => {
  it('adds requests and model calls per person per model, under a hash and a lowercased id', async () => {
    recordModelUsage('oid-a', 'GPT-5.4', { requests: 1 }, { series: 'GPT' });
    recordModelUsage('oid-a', 'gpt-5.4', { requests: 1 });
    recordModelUsage('oid-a', 'gpt-5.4', {
      calls: 1,
      promptTokens: 1000,
      completionTokens: 500,
    });
    recordModelUsage('oid-b', 'gpt-5.4', { requests: 1 });
    recordModelUsage('oid-b', 'claude-sonnet-5', { requests: 3 });
    await flushModelUsage();

    const doc = await onlyTally(DAY);
    expect(Object.keys(doc.models).sort()).toEqual([
      'claude-sonnet-5',
      'gpt-5.4',
    ]);
    expect(doc.models['gpt-5.4'].series).toBe('gpt');
    expect(doc.models['gpt-5.4'].subjects).toEqual({
      [subjectHash('oid-a')]: [2, 1, 1000, 500],
      [subjectHash('oid-b')]: [1, 0, 0, 0],
    });
    // Nobody is named anywhere in the file.
    expect(JSON.stringify(doc)).not.toContain('oid-a');
  });

  it('ignores what it cannot attribute or count, and never throws', async () => {
    recordModelUsage(undefined, 'gpt-5.4', { requests: 1 });
    recordModelUsage('', 'gpt-5.4', { requests: 1 });
    recordModelUsage('oid-a', undefined, { requests: 1 });
    recordModelUsage('oid-a', 'not a model id!', { requests: 1 });
    recordModelUsage('oid-a', 'gpt-5.4', {});
    recordModelUsage('oid-a', 'gpt-5.4', {
      requests: Number.NaN,
      promptTokens: -5,
    });
    await flushModelUsage();
    expect(await blobs.storage.listBlobs(modelUsageDayPrefix(DAY))).toEqual([]);
  });

  it('files usage under the day it happened in the policy timezone', async () => {
    // 23:30 UTC on the 23rd is already the 24th in Europe/Paris (UTC+2).
    clock = new Date(`${DAY}T23:30:00.000Z`);
    recordModelUsage('oid-a', 'gpt-5.4', { requests: 1 }, { timezone: 'UTC' });
    recordModelUsage(
      'oid-a',
      'gpt-5.4',
      { requests: 1 },
      { timezone: 'Europe/Paris' },
    );
    await flushModelUsage();
    expect((await onlyTally(DAY)).models['gpt-5.4'].subjects).toEqual({
      [subjectHash('oid-a')]: [1, 0, 0, 0],
    });
    expect((await onlyTally(NEXT_DAY)).models['gpt-5.4'].subjects).toEqual({
      [subjectHash('oid-a')]: [1, 0, 0, 0],
    });
  });

  it('keeps a failed day and writes it on the next flush, reporting the failure once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    recordModelUsage('oid-a', 'gpt-5.4', { requests: 1 });
    storageDown = true;
    await flushModelUsage();
    await flushModelUsage();
    expect(await blobs.storage.listBlobs(modelUsageDayPrefix(DAY))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);

    storageDown = false;
    await flushModelUsage();
    expect((await onlyTally(DAY)).models['gpt-5.4'].subjects).toEqual({
      [subjectHash('oid-a')]: [1, 0, 0, 0],
    });
  });

  it('folds people past the per-model limit into one bucket without losing their requests', async () => {
    for (let i = 0; i < MAX_SUBJECTS_PER_MODEL; i++) {
      recordModelUsage(`oid-${i}`, 'gpt-5.4', { requests: 1 });
    }
    // At the limit: the next NEW person overflows, a known one does not.
    recordModelUsage('oid-0', 'gpt-5.4', { requests: 1 });
    recordModelUsage('oid-new-1', 'gpt-5.4', { requests: 2 });
    recordModelUsage('oid-new-2', 'gpt-5.4', { requests: 3 });
    await flushModelUsage();

    const cell = (await onlyTally(DAY)).models['gpt-5.4'];
    expect(Object.keys(cell.subjects)).toHaveLength(MAX_SUBJECTS_PER_MODEL + 1);
    expect(cell.subjectsCapped).toBe(true);
    expect(cell.subjects[OVERFLOW_SUBJECT]).toEqual([5, 0, 0, 0]);
    expect(cell.subjects[subjectHash('oid-0')]).toEqual([2, 0, 0, 0]);
  });
});

function tally(
  replica: string,
  models: ModelUsageDoc['models'],
  day = DAY,
): ModelUsageDoc {
  return {
    version: 1,
    day,
    replica,
    updatedAt: `${day}T23:00:00.000Z`,
    models,
  };
}

describe('model day summary', () => {
  it('sums the same person across replicas and describes the day without naming anyone', async () => {
    blobs.put(
      modelUsagePath(DAY, 'r-1'),
      tally('r-1', {
        'gpt-5.4': {
          series: 'gpt',
          subjectsCapped: false,
          subjects: { a: [3, 3, 3000, 900], b: [1, 1, 500, 100] },
        },
      }),
    );
    blobs.put(
      modelUsagePath(DAY, 'r-2'),
      tally('r-2', {
        'gpt-5.4': {
          subjectsCapped: false,
          subjects: { a: [2, 4, 1000, 100], c: [0, 2, 400, 50] },
        },
      }),
    );
    // Another day's file under this day's prefix is not this day's usage.
    blobs.put(modelUsagePath(DAY, 'r-stray'), tally('r-stray', {}, NEXT_DAY));

    const doc = await buildModelDay(blobs.storage, DAY);
    expect(doc.replicas).toBe(2);
    expect(doc.bucketEdges).toEqual(REQUEST_BUCKET_EDGES);
    const cell = doc.models['gpt-5.4'];
    expect(cell.series).toBe('gpt');
    expect(cell.subjects).toEqual({
      a: [5, 7, 4000, 1000],
      b: [1, 1, 500, 100],
      c: [0, 2, 400, 50],
    });
    expect(cell.aggregate).toMatchObject({
      // c made model calls (a workflow) but sent no chat message: a person
      // who used the model, outside the requests-per-person distribution.
      people: 3,
      requests: 6,
      calls: 10,
      promptTokens: 4900,
      completionTokens: 1150,
      max: 5,
      quantiles: { p50: 1, p75: 5, p90: 5, p95: 5, p99: 5 },
    });
    // 1 request -> bucket 0; 5 requests -> the "4 to 5" bucket (index 3).
    expect(cell.aggregate.histogram[0]).toBe(1);
    expect(cell.aggregate.histogram[3]).toBe(1);
  });

  it('freezes the catalog and the assumption versions with the day', async () => {
    const doc = await buildModelDay(blobs.storage, DAY);
    expect(doc.replicas).toBe(0);
    expect(doc.models).toEqual({});
    expect(doc.catalog['gpt-5.4']).toMatchObject({
      inputPer1M: expect.any(Number),
      outputPer1M: expect.any(Number),
      sizeClass: 'large',
    });
    expect(doc.assumptions.cost).toMatch(/\d/);
    expect(doc.assumptions.emissions).toMatch(/\d/);
    expect(doc.assumptions.pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps the overflow bucket in the totals and out of the people and the distribution', () => {
    const aggregate = aggregateOf({
      a: [4, 4, 0, 0],
      [OVERFLOW_SUBJECT]: [900, 900, 0, 0],
    });
    expect(aggregate.people).toBe(1);
    expect(aggregate.requests).toBe(904);
    expect(aggregate.max).toBe(4);
  });
});

function dayDoc(
  day: string,
  models: Record<string, Record<string, [number, number, number, number]>>,
): ModelDayDoc {
  return {
    version: MODEL_DAY_VERSION,
    day,
    builtAt: `${day}T23:59:00.000Z`,
    replicas: 1,
    bucketEdges: [...REQUEST_BUCKET_EDGES],
    models: Object.fromEntries(
      Object.entries(models).map(([id, subjects]) => [
        id,
        { subjects, subjectsCapped: false, aggregate: aggregateOf(subjects) },
      ]),
    ),
    catalog: {},
    assumptions: { cost: 'c', emissions: 'e', pricingAsOf: '2026-01-01' },
  };
}

describe('model usage over a window', () => {
  it('keeps each person once, at their busiest day, and totals the rest', () => {
    const combined = combineModelDays([
      dayDoc('2026-07-21', {
        'gpt-5.4': { a: [2, 2, 10, 5], b: [9, 9, 0, 0] },
      }),
      dayDoc('2026-07-23', { 'gpt-5.4': { a: [7, 7, 30, 15] } }),
      dayDoc('2026-07-22', {
        'gpt-5.4': { a: [4, 4, 20, 10], c: [0, 1, 5, 5] },
        'claude-sonnet-5': { a: [1, 1, 0, 0] },
      }),
    ]);
    expect(combined['gpt-5.4']).toMatchObject({
      modelId: 'gpt-5.4',
      people: 3,
      requests: 22,
      calls: 23,
      promptTokens: 65,
      completionTokens: 35,
      // a on three days, b on one; c never sent a message.
      activePersonDays: 4,
      peaks: [7, 9],
      peaksTruncated: false,
    });
    expect(combined['gpt-5.4'].daily.map((d) => d.day)).toEqual([
      '2026-07-23',
      '2026-07-22',
      '2026-07-21',
    ]);
    expect(combined['claude-sonnet-5'].people).toBe(1);
  });

  it('builds a missing day once, stores it, and reads the stored copy afterwards', async () => {
    blobs.put(
      modelUsagePath(DAY, 'r-1'),
      tally('r-1', {
        'gpt-5.4': { subjectsCapped: false, subjects: { a: [3, 3, 0, 0] } },
      }),
    );
    const first = await loadModelUsage(blobs.storage, [DAY]);
    expect(first.missing).toBe(1);
    expect(first.models).toEqual({});

    const waited = await loadModelUsage(blobs.storage, [DAY], { wait: true });
    expect(waited.missing).toBe(0);
    expect(waited.capturedDays).toEqual([DAY]);
    expect(waited.models['gpt-5.4'].requests).toBe(3);
    expect(blobs.blobs.has(modelDayPath(DAY))).toBe(true);

    // A finished day is never rebuilt: later tallies do not change it.
    blobs.put(
      modelUsagePath(DAY, 'r-late'),
      tally('r-late', {
        'gpt-5.4': { subjectsCapped: false, subjects: { b: [50, 50, 0, 0] } },
      }),
    );
    const again = await loadModelUsage(blobs.storage, [DAY]);
    expect(again.missing).toBe(0);
    expect(again.models['gpt-5.4'].requests).toBe(3);
  });

  it('says a day with no capture was not captured, rather than "nobody used anything"', async () => {
    const loaded = await loadModelUsage(blobs.storage, [DAY], { wait: true });
    expect(loaded.capturedDays).toEqual([]);
    expect(loaded.models).toEqual({});
  });

  it('rides along in the insights the admin views load', async () => {
    blobs.put(
      modelUsagePath(DAY, 'r-1'),
      tally('r-1', {
        'gpt-5.4': { subjectsCapped: false, subjects: { a: [3, 3, 0, 0] } },
      }),
    );
    const insights = await loadUsageInsights('UTC', {
      storage: blobs.storage,
      now: new Date(`${NEXT_DAY}T12:00:00.000Z`),
      wait: true,
    });
    expect(insights.status).toBe('ready');
    expect(insights.modelDays).toEqual([DAY]);
    expect(insights.models['gpt-5.4']).toMatchObject({
      people: 1,
      requests: 3,
      peaks: [3],
    });
  });
});
