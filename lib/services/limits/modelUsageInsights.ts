/**
 * Per-model usage for the limits admin's Models page: who used each model,
 * how much, and how that is spread across people. Server-only.
 *
 * Input: the per-replica model usage tallies (modelUsageTally.ts). A finished
 * day is merged ONCE into `<statsPrefix>summary/model-day/<day>.json` and
 * never rebuilt, exactly like the cap summaries beside it (usageInsights.ts).
 *
 * A model day document holds, per model:
 *  - `subjects`: hashed person to that day's counts, so a person's days can
 *    be merged into a window (busiest day, distinct people) without the
 *    document naming anyone;
 *  - `aggregate`: the person-free figures for that day (people, totals, the
 *    histogram on the shared bucket edges, exact quantiles), which is what a
 *    longer trend reads without touching `subjects`.
 * and once per document a `catalog` snapshot: the price, size class and
 * lifecycle of every model as they stood that day, with the assumption-set
 * versions, so an estimate for a past day can be reproduced instead of being
 * silently recomputed with today's prices.
 *
 * See docs/MODELS_PAGE_ANALYTICS_DATA.md.
 */
import {
  OVERWRITE_BLOB,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  ModelUsageDocSchema,
  OVERFLOW_SUBJECT,
  SubjectUsageTuple,
  SubjectUsageTupleSchema,
  TUPLE,
  flushModelUsage,
  modelUsageDayPrefix,
  modelUsageRootPrefix,
} from '@/lib/services/limits/modelUsageTally';
import { LIMITS_STATS_PREFIX } from '@/lib/services/limits/types';
import { ModelUsageInsight } from '@/lib/services/limits/wire';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { COST_ASSUMPTIONS_VERSION } from '@/lib/utils/shared/costEstimator';
import { ASSUMPTIONS_VERSION } from '@/lib/utils/shared/emissions';
import {
  REQUEST_BUCKET_EDGES,
  ascending,
  histogramOf,
  quantilesOf,
} from '@/lib/utils/shared/usageDistribution';

import { OpenAIModels, PRICING_AS_OF } from '@/types/openai';

import { z } from 'zod';

/**
 * Bump when a document's shape or the histogram bucket edges change; older
 * documents are then ignored and rebuilt from the tallies.
 */
export const MODEL_DAY_VERSION = 1;
/** Per-person peaks sent to the browser per model, at most (the largest kept). */
export const MAX_PEAKS_PER_MODEL = 5_000;

const QuantileSetSchema = z.object({
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
  p95: z.number(),
  p99: z.number(),
});

/** One model's person-free figures for one day. */
export const ModelDayAggregateSchema = z.object({
  /** People with at least one request or model call that day. */
  people: z.number().int().nonnegative(),
  requests: z.number().nonnegative(),
  calls: z.number().nonnegative(),
  promptTokens: z.number().nonnegative(),
  completionTokens: z.number().nonnegative(),
  /** Most requests by one person. */
  max: z.number().nonnegative(),
  /** People per bucket of requests, on REQUEST_BUCKET_EDGES. */
  histogram: z.array(z.number().int().nonnegative()),
  /** Quantiles of requests per person, over people who made any. */
  quantiles: QuantileSetSchema,
});
export type ModelDayAggregate = z.infer<typeof ModelDayAggregateSchema>;

const ModelDayCellSchema = z.object({
  series: z.string().optional(),
  subjects: z.record(z.string(), SubjectUsageTupleSchema),
  /** Some people were folded into one bucket; `people` is a lower bound. */
  subjectsCapped: z.boolean().default(false),
  aggregate: ModelDayAggregateSchema,
});
export type ModelDayCell = z.infer<typeof ModelDayCellSchema>;

const CatalogEntrySchema = z.object({
  inputPer1M: z.number().optional(),
  outputPer1M: z.number().optional(),
  sizeClass: z.string().optional(),
  lifecycle: z.string().optional(),
  retirementDate: z.string().optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const ModelDayDocSchema = z.object({
  version: z.literal(MODEL_DAY_VERSION),
  day: z.string(),
  builtAt: z.string(),
  /** Tally files merged. 0 means nothing was captured that day. */
  replicas: z.number().int().nonnegative(),
  /** The bucket edges `histogram` was counted on. */
  bucketEdges: z.array(z.number()),
  models: z.record(z.string(), ModelDayCellSchema),
  /** Lowercased model id to its catalog facts that day. */
  catalog: z.record(z.string(), CatalogEntrySchema),
  assumptions: z.object({
    cost: z.string(),
    emissions: z.string(),
    pricingAsOf: z.string(),
  }),
});
export type ModelDayDoc = z.infer<typeof ModelDayDocSchema>;

/** Path of a day's model summary. */
export function modelDayPath(day: string): string {
  return `${LIMITS_STATS_PREFIX}summary/model-day/${day}.json`;
}

/** The catalog facts worth freezing with a day's usage. Pure. */
export function catalogSnapshot(): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (const model of Object.values(OpenAIModels)) {
    if (!model.id || model.isDisabled) continue;
    out[model.id.toLowerCase()] = {
      ...(model.pricing
        ? {
            inputPer1M: model.pricing.inputPer1M,
            outputPer1M: model.pricing.outputPer1M,
          }
        : {}),
      ...(model.sizeClass ? { sizeClass: model.sizeClass } : {}),
      ...(model.lifecycle ? { lifecycle: model.lifecycle } : {}),
      ...(model.retirementDate ? { retirementDate: model.retirementDate } : {}),
    };
  }
  return out;
}

/** The person-free figures of one model's day. Pure. */
export function aggregateOf(
  subjects: Readonly<Record<string, SubjectUsageTuple>>,
): ModelDayAggregate {
  let requests = 0;
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let people = 0;
  const perPerson: number[] = [];
  for (const [subject, usage] of Object.entries(subjects)) {
    requests += usage[TUPLE.requests];
    calls += usage[TUPLE.calls];
    promptTokens += usage[TUPLE.promptTokens];
    completionTokens += usage[TUPLE.completionTokens];
    // The overflow bucket is many people: it adds to the totals but is not
    // one person, so it stays out of the count and the distribution.
    if (subject === OVERFLOW_SUBJECT) continue;
    people += 1;
    if (usage[TUPLE.requests] > 0) perPerson.push(usage[TUPLE.requests]);
  }
  const sorted = ascending(perPerson);
  return {
    people,
    requests,
    calls,
    promptTokens,
    completionTokens,
    max: sorted.at(-1) ?? 0,
    histogram: histogramOf(sorted),
    quantiles: quantilesOf(sorted),
  };
}

/**
 * Merges every replica's tally for one finished day. Pure over the given
 * storage; writes nothing.
 */
export async function buildModelDay(
  storage: BlobStorage,
  day: string,
  now: Date = new Date(),
): Promise<ModelDayDoc> {
  const names = (await storage.listBlobs(modelUsageDayPrefix(day))).filter(
    (name) => name.endsWith('.json'),
  );
  const merged = new Map<
    string,
    {
      series?: string;
      subjects: Record<string, SubjectUsageTuple>;
      subjectsCapped: boolean;
    }
  >();
  let replicas = 0;
  for (const name of names) {
    try {
      const downloaded = await downloadBlob(
        storage,
        name,
        'limits.readModelUsage',
      );
      if (!downloaded) continue;
      const parsed = ModelUsageDocSchema.safeParse(
        JSON.parse(downloaded.buffer.toString('utf8')),
      );
      if (!parsed.success || parsed.data.day !== day) continue;
      replicas += 1;
      for (const [model, cell] of Object.entries(parsed.data.models)) {
        const target = merged.get(model) ?? {
          subjects: {},
          subjectsCapped: false,
        };
        if (cell.series && !target.series) target.series = cell.series;
        target.subjectsCapped ||= cell.subjectsCapped;
        for (const [subject, usage] of Object.entries(cell.subjects)) {
          const current = target.subjects[subject] ?? [0, 0, 0, 0];
          target.subjects[subject] = [
            current[0] + usage[0],
            current[1] + usage[1],
            current[2] + usage[2],
            current[3] + usage[3],
          ];
        }
        merged.set(model, target);
      }
    } catch (error) {
      console.warn(
        `[limits] skipped one model usage tally in the summary: ${sanitizeForLog(error)}`,
      );
    }
  }
  return {
    version: MODEL_DAY_VERSION,
    day,
    builtAt: now.toISOString(),
    replicas,
    bucketEdges: [...REQUEST_BUCKET_EDGES],
    models: Object.fromEntries(
      [...merged].map(([model, cell]) => [
        model,
        {
          ...(cell.series ? { series: cell.series } : {}),
          subjects: cell.subjects,
          subjectsCapped: cell.subjectsCapped,
          aggregate: aggregateOf(cell.subjects),
        },
      ]),
    ),
    catalog: catalogSnapshot(),
    assumptions: {
      cost: COST_ASSUMPTIONS_VERSION,
      emissions: ASSUMPTIONS_VERSION,
      pricingAsOf: PRICING_AS_OF,
    },
  };
}

/**
 * Merges model day documents (any order) into what the Models page shows.
 * Pure. Per person it keeps the BUSIEST day in the window, which is the
 * figure a cap is compared against.
 */
export function combineModelDays(
  docs: readonly ModelDayDoc[],
): Record<string, ModelUsageInsight> {
  const newestFirst = [...docs].sort((a, b) => b.day.localeCompare(a.day));
  const ids = new Set(newestFirst.flatMap((doc) => Object.keys(doc.models)));
  const out: Record<string, ModelUsageInsight> = {};
  for (const id of ids) {
    const peaks = new Map<string, number>();
    const everyone = new Set<string>();
    let series: string | undefined;
    let requests = 0;
    let calls = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let activePersonDays = 0;
    let peopleAreLowerBound = false;
    const daily: ModelUsageInsight['daily'] = [];
    for (const doc of newestFirst) {
      const cell = doc.models[id];
      if (!cell) continue;
      series ??= cell.series;
      peopleAreLowerBound ||= cell.subjectsCapped;
      requests += cell.aggregate.requests;
      calls += cell.aggregate.calls;
      promptTokens += cell.aggregate.promptTokens;
      completionTokens += cell.aggregate.completionTokens;
      daily.push({
        day: doc.day,
        people: cell.aggregate.people,
        requests: cell.aggregate.requests,
      });
      for (const [subject, usage] of Object.entries(cell.subjects)) {
        if (subject === OVERFLOW_SUBJECT) continue;
        everyone.add(subject);
        const made = usage[TUPLE.requests];
        if (made <= 0) continue;
        activePersonDays += 1;
        peaks.set(subject, Math.max(peaks.get(subject) ?? 0, made));
      }
    }
    const sorted = ascending([...peaks.values()]);
    out[id] = {
      modelId: id,
      ...(series ? { series } : {}),
      people: everyone.size,
      peopleAreLowerBound,
      requests,
      calls,
      promptTokens,
      completionTokens,
      activePersonDays,
      peaks: sorted.slice(-MAX_PEAKS_PER_MODEL),
      peaksTruncated: sorted.length > MAX_PEAKS_PER_MODEL,
      daily,
    };
  }
  return out;
}

/** In-flight builds per day, so concurrent admin requests share one. */
const building = new Map<string, Promise<ModelDayDoc | null>>();

async function readModelDay(
  storage: BlobStorage,
  day: string,
): Promise<ModelDayDoc | null> {
  const downloaded = await downloadBlob(
    storage,
    modelDayPath(day),
    'limits.readModelDay',
  );
  if (!downloaded) return null;
  const parsed = ModelDayDocSchema.safeParse(
    JSON.parse(downloaded.buffer.toString('utf8')),
  );
  return parsed.success ? parsed.data : null;
}

function buildAndStore(
  storage: BlobStorage,
  day: string,
): Promise<ModelDayDoc | null> {
  const existing = building.get(day);
  if (existing) return existing;
  const attempt = (async () => {
    try {
      // This replica's own tally for the day must be on storage first.
      await flushModelUsage();
      const doc = await buildModelDay(storage, day);
      await uploadJson(
        storage,
        modelDayPath(day),
        doc,
        OVERWRITE_BLOB,
        'limits.writeModelDay',
      );
      return doc;
    } catch (error) {
      console.warn(
        `[limits] could not build the model usage summary for ${sanitizeForLog(day)}: ${sanitizeForLog(error)}`,
      );
      return null;
    } finally {
      building.delete(day);
    }
  })();
  building.set(day, attempt);
  return attempt;
}

export interface LoadedModelUsage {
  models: Record<string, ModelUsageInsight>;
  /** Days on which at least one replica captured usage, newest first. */
  capturedDays: string[];
  /** Day documents still being built in the background. */
  missing: number;
}

/**
 * Model usage over `days` (finished days, any order). Stored day documents
 * are read; missing ones are built in the background unless `wait` is set.
 * Never throws: a storage failure reads as "nothing captured".
 */
export async function loadModelUsage(
  storage: BlobStorage,
  days: readonly string[],
  options: { wait?: boolean } = {},
): Promise<LoadedModelUsage> {
  const found: ModelDayDoc[] = [];
  let missing = 0;
  for (const day of days) {
    try {
      const stored = await readModelDay(storage, day);
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
    } catch (error) {
      console.warn(
        `[limits] could not read the model usage summary for ${sanitizeForLog(day)}: ${sanitizeForLog(error)}`,
      );
    }
  }
  // Housekeeping rides on the read that every admin view makes; it never
  // delays or fails it.
  void pruneModelUsage(storage);
  return {
    models: combineModelDays(found),
    capturedDays: found
      .filter((doc) => doc.replicas > 0)
      .map((doc) => doc.day)
      .sort((a, b) => b.localeCompare(a)),
    missing,
  };
}

// ---------------------------------------------------------------------------
// Retention of the per-replica files
// ---------------------------------------------------------------------------

/**
 * Days a replica's usage file is kept after its day. The admin container has
 * no lifecycle rule (by design: admin data must not expire silently), so the
 * app trims these itself. Longer than the insights window on purpose: every
 * day the page can show can still be rebuilt from its tallies (a late flush,
 * a {@link MODEL_DAY_VERSION} bump).
 */
export const MODEL_USAGE_RETAIN_DAYS = 14;
/** How often one process looks for files to trim, at most. */
export const MODEL_USAGE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Days trimmed per run, oldest first, so one run stays small. */
export const MODEL_USAGE_PRUNE_DAYS_PER_RUN = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let lastPruneAt = 0;
let pruneClock: () => Date = () => new Date();

/**
 * The last day whose replica files are due for removal: files for this day
 * and earlier go, later days stay. UTC, while days are policy-timezone
 * dates; the one-day slack that leaves is harmless at this length.
 */
export function modelUsageExpiryDay(now: Date): string {
  return new Date(now.getTime() - (MODEL_USAGE_RETAIN_DAYS + 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Removes the per-replica usage files of days past
 * {@link MODEL_USAGE_RETAIN_DAYS}. Nothing is lost: a day's files are only
 * removed once its summary is stored, and a day that never got one (nobody
 * opened an admin view that week) is summarised first. A day whose summary
 * cannot be built keeps its files for the next run.
 *
 * Best effort and throttled per process; never throws.
 *
 * @param options.force - Skip the throttle (tests, a manual run).
 * @returns The number of files removed.
 */
export async function pruneModelUsage(
  storage: BlobStorage,
  options: { now?: Date; force?: boolean } = {},
): Promise<number> {
  const now = options.now ?? pruneClock();
  if (
    !options.force &&
    now.getTime() - lastPruneAt < MODEL_USAGE_PRUNE_INTERVAL_MS
  ) {
    return 0;
  }
  lastPruneAt = now.getTime();
  let removed = 0;
  try {
    const root = modelUsageRootPrefix();
    const expiry = modelUsageExpiryDay(now);
    const byDay = new Map<string, string[]>();
    for (const name of await storage.listBlobs(root)) {
      const day = name.slice(root.length).split('/')[0];
      if (!DAY_RE.test(day) || day > expiry) continue;
      byDay.set(day, [...(byDay.get(day) ?? []), name]);
    }
    const due = [...byDay.keys()]
      .sort()
      .slice(0, MODEL_USAGE_PRUNE_DAYS_PER_RUN);
    for (const day of due) {
      const summary =
        (await readModelDay(storage, day)) ??
        (await buildAndStore(storage, day));
      if (!summary) continue;
      for (const name of byDay.get(day) ?? []) {
        if (await storage.deleteIfExists(name)) removed += 1;
      }
    }
  } catch (error) {
    console.warn(
      `[limits] could not trim old model usage files: ${sanitizeForLog(error)}`,
    );
  }
  return removed;
}

/** Test hook: forgets in-flight builds and the trim throttle; injects a clock. */
export function __resetModelUsageInsightsForTests(
  options: { now?: () => Date } = {},
): void {
  building.clear();
  lastPruneAt = 0;
  pruneClock = options.now ?? (() => new Date());
}
