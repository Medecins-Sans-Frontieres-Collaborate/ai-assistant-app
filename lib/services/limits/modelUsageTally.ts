/**
 * Per-model usage capture for EVERYONE, capped or not. Server-only.
 *
 * The usage counters (usageStore.ts) only exist for cells that carry a cap:
 * a request by a person with no cap on a model touches storage zero times,
 * by design. That keeps enforcement cheap, but it means the counters cannot
 * say how a model is used by the unlimited majority, and they hold no tokens
 * per model at all. The Models page needs both (docs/MODELS_PAGE_ANALYTICS_DATA.md).
 *
 * This is the same shape as the decision tallies (decisionStats.ts): the
 * request path only increments an in-memory tally, and a timer writes this
 * replica's running totals for the day to ONE blob that only this process
 * writes:
 *
 *   <statsPrefix>model-usage/<day>/<replica>.json
 *
 * so there is no contention and no read-modify-write. The reader sums every
 * replica's file for a day. Losing up to one flush interval on a crash is
 * acceptable: this is evidence for an admin view, never enforcement.
 *
 * People are stored as the same hash the day summaries use, so a person's
 * days can be merged without the tally ever naming anyone.
 *
 * TWO measures, recorded at two different points, and they are not the same
 * number:
 *  - `requests`: one per chat message admitted by the limits middleware (a
 *    tool-loop continuation is the same message). This is what a cap counts.
 *  - `calls`, `promptTokens`, `completionTokens`: one per model call that
 *    reported usage (every tool-loop round, workflows included), under the
 *    model that actually SERVED it.
 */
import { OVERWRITE_BLOB, uploadJson } from '@/lib/services/agentAccess/blobCas';
import { subjectHash } from '@/lib/services/limits/decisionStats';
import { createLimitsBlobStorage } from '@/lib/services/limits/limitsStore';
import { currentPeriod } from '@/lib/services/limits/periods';
import { LIMITS_STATS_PREFIX } from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { randomUUID } from 'crypto';
import { z } from 'zod';

/** How often a replica writes its running totals. */
export const MODEL_USAGE_FLUSH_INTERVAL_MS = 60_000;
/** Distinct people remembered per model per day; the rest share one bucket. */
export const MAX_SUBJECTS_PER_MODEL = 20_000;
/** Distinct models remembered per day; a runaway id cannot grow the file. */
export const MAX_MODELS_PER_DAY = 500;
/** The subject that stands for everyone past {@link MAX_SUBJECTS_PER_MODEL}. */
export const OVERFLOW_SUBJECT = '*';
/** Days kept in memory; older days are dropped after their last flush. */
const DAYS_IN_MEMORY = 2;
/** Model ids are stored lowercased and must look like one. */
const MODEL_ID_RE = /^[a-z0-9._:-]{1,96}$/;

/**
 * One person's day on one model, as a fixed tuple to keep the file small:
 * `[requests, calls, promptTokens, completionTokens]`.
 */
export const SubjectUsageTupleSchema = z.tuple([
  z.number().nonnegative(),
  z.number().nonnegative(),
  z.number().nonnegative(),
  z.number().nonnegative(),
]);
export type SubjectUsageTuple = z.infer<typeof SubjectUsageTupleSchema>;

/** Positions inside {@link SubjectUsageTuple}; the one place they are named. */
export const TUPLE = {
  requests: 0,
  calls: 1,
  promptTokens: 2,
  completionTokens: 3,
} as const;

export const ModelUsageCellSchema = z.object({
  /** The model's family, when the request knew it. */
  series: z.string().optional(),
  /** Hashed subject id (or {@link OVERFLOW_SUBJECT}) to that person's day. */
  subjects: z.record(z.string(), SubjectUsageTupleSchema),
  /** True when more people used it than `subjects` names one by one. */
  subjectsCapped: z.boolean().default(false),
});
export type ModelUsageCell = z.infer<typeof ModelUsageCellSchema>;

export const ModelUsageDocSchema = z.object({
  version: z.literal(1),
  day: z.string(),
  replica: z.string(),
  updatedAt: z.string(),
  /** Lowercased model id to its usage that day on this replica. */
  models: z.record(z.string(), ModelUsageCellSchema),
});
export type ModelUsageDoc = z.infer<typeof ModelUsageDocSchema>;

/** Path of one replica's model usage for one day. */
export function modelUsagePath(day: string, replica: string): string {
  return `${LIMITS_STATS_PREFIX}model-usage/${day}/${replica}.json`;
}

/** Prefix that lists every replica's model usage for a day. */
export function modelUsageDayPrefix(day: string): string {
  return `${LIMITS_STATS_PREFIX}model-usage/${day}/`;
}

/** What one recording adds. Every field defaults to 0. */
export interface ModelUsageDelta {
  requests?: number;
  calls?: number;
  promptTokens?: number;
  completionTokens?: number;
}

interface LiveCell {
  series?: string;
  subjects: Map<string, SubjectUsageTuple>;
  subjectsCapped: boolean;
}

interface RecorderState {
  replica: string;
  days: Map<string, Map<string, LiveCell>>;
  dirtyDays: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  /** A failed flush was already reported; say nothing more until one works. */
  failing: boolean;
  storage: () => BlobStorage;
  now: () => Date;
}

function freshState(): RecorderState {
  return {
    replica: `r-${randomUUID().slice(0, 12)}`,
    days: new Map(),
    dirtyDays: new Set(),
    timer: null,
    failing: false,
    storage: createLimitsBlobStorage,
    now: () => new Date(),
  };
}

let state = freshState();

function amount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Adds one observation to today's tally. Synchronous and storage-free; never
 * throws, so it can sit on the request path.
 *
 * @param userId - The subject (Entra oid); stored only as a hash. Empty: ignored.
 * @param modelId - The model the usage belongs to. Compared case-insensitively.
 * @param delta - What to add; see the module comment for which caller adds what.
 * @param options.series - The model's family, when known.
 * @param options.timezone - The policy timezone, so days match the counters.
 */
export function recordModelUsage(
  userId: string | undefined,
  modelId: string | undefined,
  delta: ModelUsageDelta,
  options: { series?: string; timezone?: string } = {},
): void {
  try {
    if (!userId || !modelId) return;
    const model = modelId.toLowerCase();
    if (!MODEL_ID_RE.test(model)) return;
    const added: SubjectUsageTuple = [
      amount(delta.requests),
      amount(delta.calls),
      amount(delta.promptTokens),
      amount(delta.completionTokens),
    ];
    if (added.every((value) => value === 0)) return;

    const day = currentPeriod('day', options.timezone ?? 'UTC', state.now());
    let models = state.days.get(day);
    if (!models) {
      models = new Map();
      state.days.set(day, models);
      trimDays();
    }
    let cell = models.get(model);
    if (!cell) {
      if (models.size >= MAX_MODELS_PER_DAY) return;
      cell = { subjects: new Map(), subjectsCapped: false };
      models.set(model, cell);
    }
    if (options.series && !cell.series) {
      cell.series = options.series.toLowerCase();
    }

    let subject = subjectHash(userId);
    if (
      !cell.subjects.has(subject) &&
      cell.subjects.size >= MAX_SUBJECTS_PER_MODEL
    ) {
      // Still counted, so totals stay right; only "who" is lost.
      subject = OVERFLOW_SUBJECT;
      cell.subjectsCapped = true;
    }
    const current = cell.subjects.get(subject) ?? [0, 0, 0, 0];
    cell.subjects.set(subject, [
      current[0] + added[0],
      current[1] + added[1],
      current[2] + added[2],
      current[3] + added[3],
    ]);
    state.dirtyDays.add(day);
    scheduleFlush();
  } catch (error) {
    console.warn(
      `[limits] could not tally model usage: ${sanitizeForLog(error)}`,
    );
  }
}

function trimDays(): void {
  const days = [...state.days.keys()].sort();
  while (days.length > DAYS_IN_MEMORY) {
    const oldest = days.shift() as string;
    if (!state.dirtyDays.has(oldest)) state.days.delete(oldest);
  }
}

function scheduleFlush(): void {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushModelUsage();
  }, MODEL_USAGE_FLUSH_INTERVAL_MS);
  state.timer.unref?.();
}

function snapshot(day: string, models: Map<string, LiveCell>): ModelUsageDoc {
  return {
    version: 1,
    day,
    replica: state.replica,
    updatedAt: state.now().toISOString(),
    models: Object.fromEntries(
      [...models].map(([model, cell]) => [
        model,
        {
          ...(cell.series ? { series: cell.series } : {}),
          subjects: Object.fromEntries(cell.subjects),
          subjectsCapped: cell.subjectsCapped,
        },
      ]),
    ),
  };
}

/**
 * Writes this replica's running totals for every day that changed since the
 * last flush. A failed day stays dirty and is retried on the next flush; the
 * failure is reported once, not once a minute. Never throws.
 */
export async function flushModelUsage(): Promise<void> {
  const days = [...state.dirtyDays];
  state.dirtyDays.clear();
  for (const day of days) {
    const models = state.days.get(day);
    if (!models) continue;
    try {
      await uploadJson(
        state.storage(),
        modelUsagePath(day, state.replica),
        snapshot(day, models),
        OVERWRITE_BLOB,
        'limits.writeModelUsage',
      );
      state.failing = false;
    } catch (error) {
      state.dirtyDays.add(day);
      if (!state.failing) {
        state.failing = true;
        console.warn(
          `[limits] could not write model usage for ${sanitizeForLog(day)} (will keep retrying quietly): ${sanitizeForLog(error)}`,
        );
      }
    }
  }
  trimDays();
  if (state.dirtyDays.size > 0) scheduleFlush();
}

/** Test hook: fresh state with injected storage and clock. */
export function __resetModelUsageTallyForTests(
  options: { storage?: () => BlobStorage; now?: () => Date } = {},
): void {
  if (state.timer) clearTimeout(state.timer);
  state = freshState();
  if (options.storage) state.storage = options.storage;
  if (options.now) state.now = options.now;
}
