/**
 * Would-block and block tallies per limit cell per day. Server-only.
 *
 * Observe mode's whole product is "what would have been stopped", and until
 * this existed the answer lived only in `[limits-audit]` log lines. The
 * admin views need it as numbers: how many times a cap was hit, by how many
 * people, under which layer.
 *
 * The request path never waits on storage. Each decision increments an
 * in-memory tally (O(1)); a timer writes this replica's running totals for
 * the day to ONE blob that only this process writes:
 *
 *   <statsPrefix>events/<day>/<replica>.json
 *
 * so there is no contention and no read-modify-write. A restart starts a new
 * replica id (and file); the reader sums every file for a day. Losing up to
 * one flush interval of tallies on a crash is acceptable for an estimate.
 *
 * Days are in the policy's timezone, matching the usage counters.
 */
import { OVERWRITE_BLOB, uploadJson } from '@/lib/services/agentAccess/blobCas';
import { createLimitsBlobStorage } from '@/lib/services/limits/limitsStore';
import { currentPeriod } from '@/lib/services/limits/periods';
import { LIMITS_STATS_PREFIX } from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';

/** How often a replica writes its running totals. */
export const DECISION_FLUSH_INTERVAL_MS = 60_000;
/** Distinct people remembered per cell per day; beyond this, counted as capped. */
export const MAX_SUBJECTS_PER_CELL = 5_000;
/** Days kept in memory; older days are dropped after their last flush. */
const DAYS_IN_MEMORY = 2;

export const DecisionTallySchema = z.object({
  limitKey: z.string(),
  modelId: z.string().optional(),
  series: z.string().optional(),
  /** Requests that hit the cap (observe: would-block; enforce: block). */
  events: z.number().int().nonnegative(),
  /** Of `events`, how many were actually refused (enforce mode). */
  blocked: z.number().int().nonnegative(),
  /** Hashed subject ids (16 hex), at most {@link MAX_SUBJECTS_PER_CELL}. */
  subjects: z.array(z.string()).max(MAX_SUBJECTS_PER_CELL),
  /** True when more distinct people hit it than `subjects` can hold. */
  subjectsCapped: z.boolean().default(false),
  /** Events by the layer whose cap was hit. */
  bySource: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type DecisionTally = z.infer<typeof DecisionTallySchema>;

export const DecisionStatsDocSchema = z.object({
  version: z.literal(1),
  day: z.string(),
  replica: z.string(),
  updatedAt: z.string(),
  cells: z.record(z.string(), DecisionTallySchema),
});
export type DecisionStatsDoc = z.infer<typeof DecisionStatsDocSchema>;

/** The decision fields the tally needs (a subset of LimitDenial). */
export interface RecordedDecision {
  limitKey: string;
  source: string;
  modelId?: string;
  series?: string;
  /** Storage was unreachable: not a real hit, never counted. */
  unavailable?: boolean;
}

/** Path of one replica's tally for one day. */
export function decisionStatsPath(day: string, replica: string): string {
  return `${LIMITS_STATS_PREFIX}events/${day}/${replica}.json`;
}

/** Prefix that lists every replica's tally for a day. */
export function decisionStatsDayPrefix(day: string): string {
  return `${LIMITS_STATS_PREFIX}events/${day}/`;
}

/** Hash used for "distinct people"; never reversible to a user id. */
export function subjectHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16);
}

/** Cell identity inside a tally document (model and family kept apart). */
export function decisionCellKey(decision: {
  limitKey: string;
  modelId?: string;
  series?: string;
}): string {
  if (decision.modelId) {
    return `${decision.limitKey}|model:${decision.modelId.toLowerCase()}`;
  }
  if (decision.series) {
    return `${decision.limitKey}|family:${decision.series.toLowerCase()}`;
  }
  return decision.limitKey;
}

interface LiveTally {
  limitKey: string;
  modelId?: string;
  series?: string;
  events: number;
  blocked: number;
  subjects: Set<string>;
  subjectsCapped: boolean;
  bySource: Record<string, number>;
}

interface RecorderState {
  replica: string;
  days: Map<string, Map<string, LiveTally>>;
  dirtyDays: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  storage: () => BlobStorage;
  now: () => Date;
}

function freshState(): RecorderState {
  return {
    replica: `r-${randomUUID().slice(0, 12)}`,
    days: new Map(),
    dirtyDays: new Set(),
    timer: null,
    storage: createLimitsBlobStorage,
    now: () => new Date(),
  };
}

let state = freshState();

/**
 * Counts one limit decision. Synchronous and storage-free; never throws.
 *
 * @param decision - The denial that was observed or enforced.
 * @param outcome - 'would-block' in observe mode, 'block' in enforce mode.
 * @param userId - The subject; stored only as a hash.
 * @param timezone - The policy's timezone, so days match the counters.
 */
export function recordDecision(
  decision: RecordedDecision,
  outcome: 'block' | 'would-block',
  userId: string,
  timezone: string,
): void {
  try {
    if (decision.unavailable) return;
    const day = currentPeriod('day', timezone, state.now());
    const cells = state.days.get(day) ?? new Map<string, LiveTally>();
    if (!state.days.has(day)) {
      state.days.set(day, cells);
      trimDays();
    }
    const key = decisionCellKey(decision);
    const tally = cells.get(key) ?? {
      limitKey: decision.limitKey,
      ...(decision.modelId ? { modelId: decision.modelId } : {}),
      ...(decision.series ? { series: decision.series } : {}),
      events: 0,
      blocked: 0,
      subjects: new Set<string>(),
      subjectsCapped: false,
      bySource: {},
    };
    tally.events += 1;
    if (outcome === 'block') tally.blocked += 1;
    tally.bySource[decision.source] =
      (tally.bySource[decision.source] ?? 0) + 1;
    const hash = subjectHash(userId);
    if (!tally.subjects.has(hash)) {
      if (tally.subjects.size < MAX_SUBJECTS_PER_CELL) tally.subjects.add(hash);
      else tally.subjectsCapped = true;
    }
    cells.set(key, tally);
    state.dirtyDays.add(day);
    scheduleFlush();
  } catch (error) {
    console.warn(
      `[limits] could not tally a limit decision: ${sanitizeForLog(error)}`,
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
    void flushDecisionStats();
  }, DECISION_FLUSH_INTERVAL_MS);
  state.timer.unref?.();
}

function snapshot(
  day: string,
  cells: Map<string, LiveTally>,
): DecisionStatsDoc {
  return {
    version: 1,
    day,
    replica: state.replica,
    updatedAt: state.now().toISOString(),
    cells: Object.fromEntries(
      [...cells].map(([key, tally]) => [
        key,
        {
          limitKey: tally.limitKey,
          ...(tally.modelId ? { modelId: tally.modelId } : {}),
          ...(tally.series ? { series: tally.series } : {}),
          events: tally.events,
          blocked: tally.blocked,
          subjects: [...tally.subjects],
          subjectsCapped: tally.subjectsCapped,
          bySource: { ...tally.bySource },
        },
      ]),
    ),
  };
}

/**
 * Writes this replica's running totals for every day that changed since the
 * last flush. A failed day stays dirty and is retried on the next flush.
 * Never throws.
 */
export async function flushDecisionStats(): Promise<void> {
  const days = [...state.dirtyDays];
  state.dirtyDays.clear();
  for (const day of days) {
    const cells = state.days.get(day);
    if (!cells) continue;
    try {
      await uploadJson(
        state.storage(),
        decisionStatsPath(day, state.replica),
        snapshot(day, cells),
        OVERWRITE_BLOB,
        'limits.writeDecisionStats',
      );
    } catch (error) {
      state.dirtyDays.add(day);
      console.warn(
        `[limits] could not write limit decision tallies for ${sanitizeForLog(day)}: ${sanitizeForLog(error)}`,
      );
    }
  }
  trimDays();
  if (state.dirtyDays.size > 0) scheduleFlush();
}

/** Test hook: fresh state with injected storage and clock. */
export function __resetDecisionStatsForTests(
  options: { storage?: () => BlobStorage; now?: () => Date } = {},
): void {
  if (state.timer) clearTimeout(state.timer);
  state = freshState();
  if (options.storage) state.storage = options.storage;
  if (options.now) state.now = options.now;
}
