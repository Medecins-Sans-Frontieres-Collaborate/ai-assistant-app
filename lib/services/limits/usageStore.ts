/**
 * Durable usage counters, on Azure Blob compare-and-swap.
 *
 * Azure Blob is the entire datastore menu in this app — no Redis, no Cosmos,
 * no Table Storage — so the guarantee has to come from ETag preconditions
 * rather than an atomic INCR.
 *
 * The shape that makes that work:
 *
 *  - ONE document per (subject, periodKind, period) holding ALL of that
 *    window's counters. A chat request debiting `chat.messagesPerDay` +
 *    `model:<id>.requests` + `family:<series>.requests` does so in a SINGLE
 *    swap: all-or-nothing, one GET and one PUT, and contention is only that
 *    one user's own concurrency rather than the whole org's.
 *
 *  - The limit comparison happens INSIDE the CAS loop. Two replicas racing
 *    the same user cannot both admit the request that crosses the boundary:
 *    the loser's conditional write fails with 412, re-reads, and re-checks
 *    against the winner's incremented value. This is what makes a request
 *    count a limit rather than an estimate.
 *
 *  - When every resolved counter is unlimited, `reserve` returns before
 *    touching storage AT ALL. Since almost everything defaults to unlimited,
 *    the overwhelming majority of requests pay only a map lookup, and the
 *    latency lands solely on principals an admin deliberately metered.
 *
 * ⚠ Writes MUST go through blobCas.uploadJson (getBlockBlobClient().upload
 * with conditions), never AzureBlobStorage.upload(): its same-byte-length
 * dedupe returns early WITHOUT writing when the stored content length equals
 * the new one, and `{"count":41}` → `{"count":42}` is exactly that case.
 * Every increment would silently vanish.
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import { createLimitsBlobStorage } from '@/lib/services/limits/limitsStore';
import { currentPeriod, resetAt } from '@/lib/services/limits/periods';
import {
  LIMITS_USAGE_PREFIX,
  PeriodKind,
  UsageDoc,
  UsageDocSchema,
} from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { createHash } from 'node:crypto';

/** 412 → jittered retry. Six attempts covers realistic same-user concurrency. */
const CAS_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 10;

/**
 * Sharded by a hash prefix so no flat listing is unbounded, and so an expired
 * period is a single prefix to prune. The subject id is hashed rather than
 * interpolated: it keeps the path shape fixed regardless of the id's
 * contents, and keeps a directory listing from enumerating user ids.
 */
export function usageBlobPath(
  subjectId: string,
  periodKind: PeriodKind,
  period: string,
): string {
  const hash = createHash('sha256').update(subjectId).digest('hex');
  return `${LIMITS_USAGE_PREFIX}${periodKind}/${period}/${hash.slice(0, 2)}/${hash}.json`;
}

export interface CounterRequest {
  /** Counter cell name inside the document. */
  cell: string;
  /** How much this request consumes. */
  cost: number;
  /** Resolved cap for this cell; the check is `used + cost > limit`. */
  limit: number;
  /** Echoed back on denial so the caller can name the limit to the user. */
  limitKey: string;
  /** Which policy layer produced the cap — carried through for the audit line. */
  source?: string;
  modelId?: string;
  series?: string;
}

export interface ReserveDenial {
  limitKey: string;
  cell: string;
  limit: number;
  used: number;
  resetAt?: string;
  source?: string;
  modelId?: string;
  series?: string;
}

export interface ReserveResult {
  allowed: boolean;
  denial?: ReserveDenial;
  /** True when storage was unreachable and the configured failMode decided. */
  failedOpen?: boolean;
  /** Cells actually debited — the input for a compensating release(). */
  debited?: CounterRequest[];
}

const ALLOWED_NO_OP: ReserveResult = { allowed: true };

function backoffMs(attempt: number): number {
  // Deterministic base with jitter: two replicas that collide must not retry
  // in lockstep forever.
  return BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshDoc(
  subjectId: string,
  periodKind: PeriodKind,
  period: string,
): UsageDoc {
  return {
    version: 1,
    subjectId,
    periodKind,
    period,
    counters: {},
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Reserves capacity for all `counters` in one compare-and-swap, or denies.
 *
 * `failMode` decides what an unreachable storage account means: 'open' allows
 * the request (a quota is a cost control, and a blob outage must not be a
 * chat outage), 'closed' denies it.
 */
export async function reserve(
  subjectId: string,
  periodKind: PeriodKind,
  counters: CounterRequest[],
  options: {
    timezone?: string;
    failMode?: 'open' | 'closed';
    storage?: BlobStorage;
    now?: Date;
  } = {},
): Promise<ReserveResult> {
  if (counters.length === 0) return ALLOWED_NO_OP;

  const timezone = options.timezone ?? 'UTC';
  const period = currentPeriod(periodKind, timezone, options.now);
  const storage = options.storage ?? createLimitsBlobStorage();
  const path = usageBlobPath(subjectId, periodKind, period);

  for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
    try {
      const downloaded = await downloadBlob(storage, path, 'limits.readUsage');
      let doc: UsageDoc;
      let etag: string | null;
      if (downloaded === null) {
        doc = freshDoc(subjectId, periodKind, period);
        etag = null;
      } else {
        etag = downloaded.etag;
        const parsed = UsageDocSchema.safeParse(
          JSON.parse(downloaded.buffer.toString('utf8')),
        );
        // Lazy period rollover: a stale document for a previous period is
        // replaced wholesale rather than migrated. Same for an unparseable
        // one — a corrupt counter must not permanently block a user.
        doc =
          parsed.success && parsed.data.period === period
            ? parsed.data
            : freshDoc(subjectId, periodKind, period);
      }

      // ── The check that makes this exact: inside the loop, against the
      //    value we are about to conditionally write over.
      for (const counter of counters) {
        const used = doc.counters[counter.cell] ?? 0;
        if (used + counter.cost > counter.limit) {
          return {
            allowed: false,
            denial: {
              limitKey: counter.limitKey,
              cell: counter.cell,
              limit: counter.limit,
              used,
              resetAt: resetAt(periodKind, timezone, options.now),
              ...(counter.source ? { source: counter.source } : {}),
              ...(counter.modelId ? { modelId: counter.modelId } : {}),
              ...(counter.series ? { series: counter.series } : {}),
            },
          };
        }
      }

      const next: UsageDoc = {
        ...doc,
        counters: { ...doc.counters },
        updatedAt: new Date().toISOString(),
      };
      for (const counter of counters) {
        next.counters[counter.cell] =
          (next.counters[counter.cell] ?? 0) + counter.cost;
      }

      await uploadJson(storage, path, next, etag, 'limits.writeUsage');
      return { allowed: true, debited: counters };
    } catch (error) {
      if (error instanceof AgentAccessConflictError) {
        if (attempt < CAS_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        console.error(
          `[limits] usage CAS exhausted after ${CAS_ATTEMPTS} attempts for period=${period}`,
        );
      } else {
        console.error(
          `[limits] usage reserve failed (attempt ${attempt}/${CAS_ATTEMPTS}): ${sanitizeForLog(error)}`,
        );
        if (attempt < CAS_ATTEMPTS && isTransient(error)) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
      const failMode = options.failMode ?? 'open';
      if (failMode === 'open') {
        console.error('[limits] FAIL-OPEN: usage not counted, request allowed');
        return { allowed: true, failedOpen: true };
      }
      return {
        allowed: false,
        failedOpen: false,
        denial: {
          limitKey: counters[0].limitKey,
          cell: counters[0].cell,
          limit: counters[0].limit,
          used: counters[0].limit,
          resetAt: resetAt(periodKind, timezone, options.now),
        },
      };
    }
  }
  return ALLOWED_NO_OP;
}

function isTransient(error: unknown): boolean {
  const status =
    (error as { statusCode?: number; status?: number })?.statusCode ??
    (error as { status?: number })?.status;
  return status === undefined || status >= 500;
}

/**
 * Best-effort compensating decrement, used when a LATER reservation in the
 * same request denies (a request bound by both a daily and a monthly limit
 * touches two documents, and two documents cannot be swapped atomically).
 *
 * Reservations are made in a fixed order — day, then month — so the worst
 * case under a crash between them is one daily unit charged for a rejected
 * request: bounded, one-directional, and strict (over-charged, never
 * under-charged).
 */
export async function release(
  subjectId: string,
  periodKind: PeriodKind,
  counters: CounterRequest[],
  options: { timezone?: string; storage?: BlobStorage; now?: Date } = {},
): Promise<void> {
  if (counters.length === 0) return;
  const timezone = options.timezone ?? 'UTC';
  const period = currentPeriod(periodKind, timezone, options.now);
  const storage = options.storage ?? createLimitsBlobStorage();
  const path = usageBlobPath(subjectId, periodKind, period);

  for (let attempt = 1; attempt <= CAS_ATTEMPTS; attempt++) {
    try {
      const downloaded = await downloadBlob(storage, path, 'limits.readUsage');
      if (downloaded === null) return;
      const parsed = UsageDocSchema.safeParse(
        JSON.parse(downloaded.buffer.toString('utf8')),
      );
      if (!parsed.success || parsed.data.period !== period) return;
      const next: UsageDoc = {
        ...parsed.data,
        counters: { ...parsed.data.counters },
        updatedAt: new Date().toISOString(),
      };
      for (const counter of counters) {
        next.counters[counter.cell] = Math.max(
          0,
          (next.counters[counter.cell] ?? 0) - counter.cost,
        );
      }
      await uploadJson(
        storage,
        path,
        next,
        downloaded.etag,
        'limits.writeUsage',
      );
      return;
    } catch (error) {
      if (error instanceof AgentAccessConflictError && attempt < CAS_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      // A failed release over-charges by design rather than risking a
      // double-refund. Logged, never thrown at the caller.
      console.error(
        `[limits] usage release failed (non-fatal): ${sanitizeForLog(error)}`,
      );
      return;
    }
  }
}

/** Current consumption for a subject/window. Returns {} when none exists. */
export async function readUsage(
  subjectId: string,
  periodKind: PeriodKind,
  options: { timezone?: string; storage?: BlobStorage; now?: Date } = {},
): Promise<Record<string, number>> {
  const timezone = options.timezone ?? 'UTC';
  const period = currentPeriod(periodKind, timezone, options.now);
  const storage = options.storage ?? createLimitsBlobStorage();
  const downloaded = await downloadBlob(
    storage,
    usageBlobPath(subjectId, periodKind, period),
    'limits.readUsage',
  );
  if (downloaded === null) return {};
  const parsed = UsageDocSchema.safeParse(
    JSON.parse(downloaded.buffer.toString('utf8')),
  );
  if (!parsed.success || parsed.data.period !== period) return {};
  return parsed.data.counters;
}
