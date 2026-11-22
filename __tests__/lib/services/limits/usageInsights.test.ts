import {
  DecisionStatsDoc,
  __resetDecisionStatsForTests,
  decisionStatsPath,
  flushDecisionStats,
  recordDecision,
  subjectHash,
} from '@/lib/services/limits/decisionStats';
import { UsageDoc } from '@/lib/services/limits/types';
import {
  DaySummary,
  __resetUsageInsightsForTests,
  bandOf,
  buildDaySummary,
  combineSummaries,
  daySummaryPath,
  insightDays,
  loadUsageInsights,
  parseCell,
} from '@/lib/services/limits/usageInsights';
import { usageBlobPath } from '@/lib/services/limits/usageStore';

import { MemoryBlobStorage, memoryBlobStorage } from './memoryBlobStorage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The evidence pipeline: decisions are tallied in memory and flushed per
 * replica; a finished day's usage documents and tallies become one summary;
 * summaries merge into what the admin views show. Band and cap boundaries
 * are tested on both sides.
 */

const NOW = new Date('2026-07-24T12:00:00.000Z');
const DAY = '2026-07-23';

function usageDoc(
  subjectId: string,
  counters: Record<string, number>,
  caps?: UsageDoc['caps'],
): UsageDoc {
  return {
    version: 1,
    subjectId,
    periodKind: 'day',
    period: DAY,
    counters,
    ...(caps ? { caps } : {}),
    updatedAt: `${DAY}T10:00:00.000Z`,
  };
}

let blobs: MemoryBlobStorage;

beforeEach(() => {
  blobs = memoryBlobStorage();
  __resetDecisionStatsForTests({
    storage: () => blobs.storage,
    now: () => new Date(`${DAY}T15:00:00.000Z`),
  });
  __resetUsageInsightsForTests();
});

afterEach(() => {
  __resetDecisionStatsForTests();
});

describe('decision tallies', () => {
  it('counts events and distinct people per cell, and ignores unavailable counters', async () => {
    const hit = { limitKey: 'chat.messagesPerDay', source: 'global' };
    recordDecision(hit, 'would-block', 'oid-a', 'UTC');
    recordDecision(hit, 'would-block', 'oid-a', 'UTC');
    recordDecision(hit, 'block', 'oid-b', 'UTC');
    recordDecision({ ...hit, unavailable: true }, 'block', 'oid-c', 'UTC');
    recordDecision(
      { limitKey: 'model.requests', source: 'group', modelId: 'GPT-5.2' },
      'would-block',
      'oid-a',
      'UTC',
    );
    await flushDecisionStats();

    const files = await blobs.storage.listBlobs(
      `system/limits/stats/events/${DAY}/`,
    );
    expect(files).toHaveLength(1);
    const doc = blobs.json(files[0]) as DecisionStatsDoc;
    expect(doc.cells['chat.messagesPerDay']).toMatchObject({
      events: 3,
      blocked: 1,
      bySource: { global: 3 },
    });
    expect(doc.cells['chat.messagesPerDay'].subjects).toHaveLength(2);
    expect(doc.cells['model.requests|model:gpt-5.2'].events).toBe(1);
    // Never the raw id.
    expect(JSON.stringify(doc)).not.toContain('oid-a');
  });

  it('writes nothing when nothing was decided', async () => {
    await flushDecisionStats();
    expect(blobs.blobs.size).toBe(0);
  });
});

describe('parseCell and bandOf', () => {
  it('maps counter names back to cells and skips shadow and unknown cells', () => {
    expect(parseCell('chat.messagesPerDay')).toEqual({
      limitKey: 'chat.messagesPerDay',
    });
    expect(parseCell('model:gpt-5.2.requests')).toEqual({
      limitKey: 'model.requests',
      modelId: 'gpt-5.2',
    });
    expect(parseCell('family:gpt.requests')).toEqual({
      limitKey: 'model.requests',
      series: 'gpt',
    });
    expect(parseCell('chat.tokensPerDay#workflow')).toBeNull();
    expect(parseCell('not.a.key')).toBeNull();
  });

  it('puts the band edges on the right side', () => {
    expect(bandOf(49, 100)).toBe('underHalf');
    expect(bandOf(50, 100)).toBe('toEighty');
    expect(bandOf(79, 100)).toBe('toEighty');
    expect(bandOf(80, 100)).toBe('nearCap');
    expect(bandOf(99, 100)).toBe('nearCap');
    expect(bandOf(100, 100)).toBe('atCap');
    expect(bandOf(0, 0)).toBe('atCap');
  });
});

describe('buildDaySummary', () => {
  it('summarises usage documents and folds in every replica’s tallies', async () => {
    blobs.put(
      usageBlobPath('oid-a', 'day', DAY),
      usageDoc(
        'oid-a',
        { 'chat.messagesPerDay': 200, 'model:gpt-5.2.requests': 3 },
        { 'chat.messagesPerDay': { limit: 200, rule: 'global' } },
      ),
    );
    blobs.put(
      usageBlobPath('oid-b', 'day', DAY),
      usageDoc('oid-b', { 'chat.messagesPerDay': 20 }),
    );
    // A document from another day under this prefix is ignored.
    blobs.put(usageBlobPath('oid-c', 'day', DAY), {
      ...usageDoc('oid-c', { 'chat.messagesPerDay': 5 }),
      period: '2026-07-22',
    });
    const tally = (replica: string, events: number, subject: string) =>
      blobs.put(decisionStatsPath(DAY, replica), {
        version: 1,
        day: DAY,
        replica,
        updatedAt: NOW.toISOString(),
        cells: {
          'chat.messagesPerDay': {
            limitKey: 'chat.messagesPerDay',
            events,
            blocked: 0,
            subjects: [subject],
            subjectsCapped: false,
            bySource: { global: events },
          },
        },
      });
    tally('r-1', 4, subjectHash('oid-a'));
    tally('r-2', 2, subjectHash('oid-a'));

    const summary = await buildDaySummary(blobs.storage, DAY, NOW);
    expect(summary.documents).toBe(3);
    expect(summary.complete).toBe(true);
    const messages = summary.cells['chat.messagesPerDay'];
    expect(Object.keys(messages.subjects)).toHaveLength(2);
    expect(messages.subjects[subjectHash('oid-a')]).toEqual({
      u: 200,
      c: 200,
      r: 'global',
    });
    expect(messages.events).toBe(6);
    expect(messages.eventSubjects).toEqual([subjectHash('oid-a')]);
    expect(summary.cells['model.requests|model:gpt-5.2']).toBeDefined();
  });
});

describe('combineSummaries', () => {
  const day = (name: string, cells: DaySummary['cells']): DaySummary => ({
    version: 1,
    day: name,
    builtAt: NOW.toISOString(),
    complete: true,
    documents: 1,
    cells,
  });
  const cell = (
    subjects: DaySummary['cells'][string]['subjects'],
    events = 0,
  ): DaySummary['cells'][string] => ({
    limitKey: 'chat.messagesPerDay',
    subjects,
    events,
    blocked: 0,
    eventSubjects: events ? ['h-a'] : [],
  });

  it('takes bands from the newest day and each person’s peak across days', () => {
    const insights = combineSummaries([
      day('2026-07-23', {
        'chat.messagesPerDay': cell(
          {
            'h-a': { u: 200, c: 200, r: 'global' },
            'h-b': { u: 10, c: 200, r: 'global' },
            'h-c': { u: 7 },
          },
          3,
        ),
      }),
      day('2026-07-22', {
        'chat.messagesPerDay': cell(
          { 'h-b': { u: 170, c: 500, r: 'lim-000000000001' } },
          1,
        ),
      }),
    ])['chat.messagesPerDay'];

    expect(insights.yesterday).toEqual({
      people: 3,
      bands: { underHalf: 1, toEighty: 0, nearCap: 0, atCap: 1 },
      withoutCap: 1,
    });
    expect(insights.peaks).toEqual([7, 170, 200]);
    expect(insights.events).toBe(4);
    expect(insights.eventPeople).toBe(1);
    expect(insights.byRule).toEqual({
      global: { people: 2, atCap: 1 },
      'lim-000000000001': { people: 1, atCap: 0 },
    });
  });
});

describe('loadUsageInsights', () => {
  it('lists the finished days, newest first, never today', () => {
    const days = insightDays('UTC', NOW);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-07-23');
    expect(days).not.toContain('2026-07-24');
  });

  it('answers building, then serves and stores the built summaries', async () => {
    blobs.put(
      usageBlobPath('oid-a', 'day', DAY),
      usageDoc(
        'oid-a',
        { 'chat.messagesPerDay': 50 },
        { 'chat.messagesPerDay': { limit: 100, rule: 'global' } },
      ),
    );
    const first = await loadUsageInsights('UTC', {
      storage: blobs.storage,
      now: NOW,
    });
    expect(first.status).toBe('building');

    await vi.waitFor(() =>
      expect(blobs.json(daySummaryPath(DAY))).toBeDefined(),
    );
    const again = await loadUsageInsights('UTC', {
      storage: blobs.storage,
      now: NOW,
      wait: true,
    });
    expect(again.latestDay).toBe(DAY);
    expect(again.cells['chat.messagesPerDay'].yesterday.bands.toEighty).toBe(1);
  });
});
