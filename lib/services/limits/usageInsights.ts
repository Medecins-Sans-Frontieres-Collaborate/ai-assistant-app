/**
 * Usage evidence for the limits admin: how close people came to their caps,
 * and how often a cap stopped (or in observe mode would have stopped) them.
 * Server-only.
 *
 * Inputs:
 *  - the usage documents (one per person per day, usageStore.ts), which
 *    carry each metered cell's count and, since `caps` was added, the cap
 *    and the rule that set it;
 *  - the decision tallies (decisionStats.ts), one file per replica per day.
 *
 * A finished day is summarised ONCE into `<statsPrefix>summary/day/<day>.json`
 * and never rebuilt; the admin endpoint reads the last {@link INSIGHT_DAYS}
 * summaries and builds missing ones in the background. Summaries hold
 * hashed subject ids only, so a person's peak can be merged across days
 * without the summary ever naming anyone.
 *
 * ⚠ In observe mode a counter stops at the cap (routeGuard.ts), so usage
 * reads "reached the cap" rather than true demand above it. The decision
 * tallies are what measure demand past a cap.
 */
import {
  OVERWRITE_BLOB,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  DecisionStatsDocSchema,
  decisionCellKey,
  decisionStatsDayPrefix,
  flushDecisionStats,
  subjectHash,
} from '@/lib/services/limits/decisionStats';
import { createLimitsBlobStorage } from '@/lib/services/limits/limitsStore';
import { currentPeriod } from '@/lib/services/limits/periods';
import {
  LIMITS_STATS_PREFIX,
  LIMITS_USAGE_PREFIX,
  UsageDocSchema,
} from '@/lib/services/limits/types';
import {
  CellInsight,
  PressureBands,
  UsageInsights,
} from '@/lib/services/limits/wire';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { getLimitDefinition } from '@/config/limits';
import { z } from 'zod';

/** Days of evidence the admin views show. */
export const INSIGHT_DAYS = 7;
/** Usage documents read per day summary; beyond this it is marked partial. */
export const MAX_DOCS_PER_DAY = 20_000;
/** Parallel blob reads while building a summary. */
const READ_CONCURRENCY = 16;
/** Per-person peaks sent to the browser per cell, at most. */
export const MAX_PEAKS_PER_CELL = 5_000;

/** Fractions of the cap that split people into the pressure bands. */
export const PRESSURE_BANDS = { half: 0.5, near: 0.8 } as const;

const SubjectUsageSchema = z.object({
  /** Count for the day. */
  u: z.number().nonnegative(),
  /** Cap at the latest debit, when recorded. */
  c: z.number().nonnegative().optional(),
  /** Rule that set the cap, when recorded. */
  r: z.string().optional(),
});

const CellSummarySchema = z.object({
  limitKey: z.string(),
  modelId: z.string().optional(),
  series: z.string().optional(),
  /** Hashed subject → that person's day. */
  subjects: z.record(z.string(), SubjectUsageSchema),
  events: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  /** Hashed subjects who hit the cap at least once that day. */
  eventSubjects: z.array(z.string()).default([]),
});
type CellSummary = z.infer<typeof CellSummarySchema>;

export const DaySummarySchema = z.object({
  version: z.literal(1),
  day: z.string(),
  builtAt: z.string(),
  /** False when the document cap was reached and some people are missing. */
  complete: z.boolean(),
  documents: z.number().int().nonnegative(),
  cells: z.record(z.string(), CellSummarySchema),
});
export type DaySummary = z.infer<typeof DaySummarySchema>;

/** Path of a day's summary. */
export function daySummaryPath(day: string): string {
  return `${LIMITS_STATS_PREFIX}summary/day/${day}.json`;
}

/** The finished days to show, newest first, in `timezone`. */
export function insightDays(
  timezone: string,
  now: Date = new Date(),
): string[] {
  const days: string[] = [];
  // Step back from today in whole UTC days, then name each instant's day in
  // the policy zone; skipping today keeps every summary final.
  const today = currentPeriod('day', timezone, now);
  for (
    let back = 1;
    days.length < INSIGHT_DAYS && back <= INSIGHT_DAYS + 2;
    back++
  ) {
    const day = currentPeriod(
      'day',
      timezone,
      new Date(now.getTime() - back * 86_400_000),
    );
    if (day !== today && !days.includes(day)) days.push(day);
  }
  return days;
}

/**
 * Summarises one finished day from the usage documents and decision tallies.
 * Pure over the given storage; writes nothing.
 */
export async function buildDaySummary(
  storage: BlobStorage,
  day: string,
  now: Date = new Date(),
): Promise<DaySummary> {
  const prefix = `${LIMITS_USAGE_PREFIX}day/${day}/`;
  const names = (await storage.listBlobs(prefix)).filter((name) =>
    name.endsWith('.json'),
  );
  const complete = names.length <= MAX_DOCS_PER_DAY;
  const toRead = names.slice(0, MAX_DOCS_PER_DAY);
  const cells: Record<string, CellSummary> = {};

  await forEachLimited(toRead, READ_CONCURRENCY, async (name) => {
    const downloaded = await downloadBlob(
      storage,
      name,
      'limits.readUsageForSummary',
    );
    if (!downloaded) return;
    const parsed = UsageDocSchema.safeParse(
      JSON.parse(downloaded.buffer.toString('utf8')),
    );
    if (!parsed.success || parsed.data.period !== day) return;
    const doc = parsed.data;
    const subject = subjectHash(doc.subjectId);
    for (const [cell, used] of Object.entries(doc.counters)) {
      const identity = parseCell(cell);
      if (!identity || used <= 0) continue;
      const key = decisionCellKey(identity);
      const summary = (cells[key] ??= {
        ...identity,
        subjects: {},
        events: 0,
        blocked: 0,
        eventSubjects: [],
      });
      const cap = doc.caps?.[cell];
      summary.subjects[subject] = {
        u: used,
        ...(cap ? { c: cap.limit, r: cap.rule } : {}),
      };
    }
  });

  await addDecisionTallies(storage, day, cells);

  return {
    version: 1,
    day,
    builtAt: now.toISOString(),
    complete,
    documents: toRead.length,
    cells,
  };
}

/**
 * The cell a counter name stands for. Counter names are the limit key, or
 * `model:<id>.<suffix>` / `family:<series>.<suffix>` for per-model keys
 * (resolver.counterCellName); workflow shadow cells and unknown keys are
 * skipped.
 */
export function parseCell(
  cell: string,
): { limitKey: string; modelId?: string; series?: string } | null {
  const qualified = /^(model|family):(.+)\.([A-Za-z]+)$/.exec(cell);
  if (qualified) {
    const [, kind, dimension, suffix] = qualified;
    const limitKey = `model.${suffix}`;
    if (!getLimitDefinition(limitKey)) return null;
    return kind === 'model'
      ? { limitKey, modelId: dimension }
      : { limitKey, series: dimension };
  }
  return getLimitDefinition(cell) ? { limitKey: cell } : null;
}

async function addDecisionTallies(
  storage: BlobStorage,
  day: string,
  cells: Record<string, CellSummary>,
): Promise<void> {
  const files = await storage.listBlobs(decisionStatsDayPrefix(day));
  for (const name of files) {
    const downloaded = await downloadBlob(
      storage,
      name,
      'limits.readDecisionStats',
    );
    if (!downloaded) continue;
    const parsed = DecisionStatsDocSchema.safeParse(
      JSON.parse(downloaded.buffer.toString('utf8')),
    );
    if (!parsed.success) continue;
    for (const [key, tally] of Object.entries(parsed.data.cells)) {
      const summary = (cells[key] ??= {
        limitKey: tally.limitKey,
        ...(tally.modelId ? { modelId: tally.modelId } : {}),
        ...(tally.series ? { series: tally.series } : {}),
        subjects: {},
        events: 0,
        blocked: 0,
        eventSubjects: [],
      });
      summary.events += tally.events;
      summary.blocked += tally.blocked;
      summary.eventSubjects = [
        ...new Set([...summary.eventSubjects, ...tally.subjects]),
      ];
    }
  }
}

async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await run(item);
      } catch (error) {
        console.warn(
          `[limits] skipped one usage document in the summary: ${sanitizeForLog(error)}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

/** Which pressure band a day's usage falls in against its cap. */
export function bandOf(used: number, cap: number): keyof PressureBands {
  if (cap <= 0 || used >= cap) return 'atCap';
  const ratio = used / cap;
  if (ratio >= PRESSURE_BANDS.near) return 'nearCap';
  if (ratio >= PRESSURE_BANDS.half) return 'toEighty';
  return 'underHalf';
}

/**
 * Merges day summaries (newest first) into what the admin views show.
 * Pure.
 */
export function combineSummaries(
  summaries: readonly DaySummary[],
): Record<string, CellInsight> {
  const latest = summaries[0];
  const keys = new Set(summaries.flatMap((s) => Object.keys(s.cells)));
  const out: Record<string, CellInsight> = {};
  for (const key of keys) {
    const sample = summaries.find((s) => s.cells[key])?.cells[key];
    if (!sample) continue;
    const bands: PressureBands = {
      underHalf: 0,
      toEighty: 0,
      nearCap: 0,
      atCap: 0,
    };
    let withoutCap = 0;
    const today = latest?.cells[key];
    for (const usage of Object.values(today?.subjects ?? {})) {
      if (usage.c === undefined) withoutCap += 1;
      else bands[bandOf(usage.u, usage.c)] += 1;
    }

    const peaks = new Map<string, number>();
    const rules = new Map<
      string,
      { people: Set<string>; atCap: Set<string> }
    >();
    let events = 0;
    let blocked = 0;
    const eventPeople = new Set<string>();
    for (const summary of summaries) {
      const cell = summary.cells[key];
      if (!cell) continue;
      events += cell.events;
      blocked += cell.blocked;
      for (const subject of cell.eventSubjects) eventPeople.add(subject);
      for (const [subject, usage] of Object.entries(cell.subjects)) {
        peaks.set(subject, Math.max(peaks.get(subject) ?? 0, usage.u));
        if (usage.r === undefined) continue;
        const rule = rules.get(usage.r) ?? {
          people: new Set(),
          atCap: new Set(),
        };
        rule.people.add(subject);
        if (usage.c !== undefined && bandOf(usage.u, usage.c) === 'atCap') {
          rule.atCap.add(subject);
        }
        rules.set(usage.r, rule);
      }
    }
    const sorted = [...peaks.values()].sort((a, b) => a - b);
    out[key] = {
      limitKey: sample.limitKey,
      ...(sample.modelId ? { modelId: sample.modelId } : {}),
      ...(sample.series ? { series: sample.series } : {}),
      yesterday: {
        people: Object.keys(today?.subjects ?? {}).length,
        bands,
        withoutCap,
      },
      byRule: Object.fromEntries(
        [...rules].map(([rule, sets]) => [
          rule,
          { people: sets.people.size, atCap: sets.atCap.size },
        ]),
      ),
      events,
      eventPeople: eventPeople.size,
      blocked,
      peaks: sorted.slice(-MAX_PEAKS_PER_CELL),
      peaksTruncated: sorted.length > MAX_PEAKS_PER_CELL,
    };
  }
  return out;
}

/** In-flight builds per day, so concurrent admin requests share one. */
const building = new Map<string, Promise<DaySummary | null>>();

async function readSummary(
  storage: BlobStorage,
  day: string,
): Promise<DaySummary | null> {
  const downloaded = await downloadBlob(
    storage,
    daySummaryPath(day),
    'limits.readDaySummary',
  );
  if (!downloaded) return null;
  const parsed = DaySummarySchema.safeParse(
    JSON.parse(downloaded.buffer.toString('utf8')),
  );
  return parsed.success ? parsed.data : null;
}

function buildAndStore(
  storage: BlobStorage,
  day: string,
): Promise<DaySummary | null> {
  const existing = building.get(day);
  if (existing) return existing;
  const attempt = (async () => {
    try {
      // This replica's own tallies for the day must be on storage first.
      await flushDecisionStats();
      const summary = await buildDaySummary(storage, day);
      await uploadJson(
        storage,
        daySummaryPath(day),
        summary,
        OVERWRITE_BLOB,
        'limits.writeDaySummary',
      );
      return summary;
    } catch (error) {
      console.warn(
        `[limits] could not build the usage summary for ${sanitizeForLog(day)}: ${sanitizeForLog(error)}`,
      );
      return null;
    } finally {
      building.delete(day);
    }
  })();
  building.set(day, attempt);
  return attempt;
}

/**
 * The evidence for the admin views. Reads the stored day summaries; any that
 * are missing are built in the background and the answer says 'building',
 * so the caller can ask again shortly rather than wait.
 *
 * @param timezone - The policy timezone (days follow the counters).
 * @param options.storage - Injected for tests.
 * @param options.wait - Await missing builds instead of answering 'building'.
 */
export async function loadUsageInsights(
  timezone: string,
  options: { storage?: BlobStorage; now?: Date; wait?: boolean } = {},
): Promise<UsageInsights> {
  const storage = options.storage ?? createLimitsBlobStorage();
  const days = insightDays(timezone, options.now);
  const found: DaySummary[] = [];
  let missing = 0;
  for (const day of days) {
    const stored = await readSummary(storage, day);
    if (stored) {
      found.push(stored);
      continue;
    }
    const build = buildAndStore(storage, day);
    if (options.wait) {
      const built = await build;
      if (built) found.push(built);
    } else {
      missing += 1;
    }
  }
  found.sort((a, b) => b.day.localeCompare(a.day));
  return {
    status: missing > 0 ? 'building' : 'ready',
    latestDay: days[0],
    days: found.map((s) => s.day),
    partial: found.some((s) => !s.complete),
    cells: combineSummaries(found),
  };
}

/** Test hook. */
export function __resetUsageInsightsForTests(): void {
  building.clear();
}
