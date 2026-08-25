/**
 * Blob-backed store for M365 agent index jobs (seventh pass, phase 2).
 *
 * One record per agent at `system/agent-access/m365-agent-jobs/<agentId>.json`
 * in the admin container. Every mutation is compare-and-swap on the blob
 * ETag with bounded re-read-and-reapply on 412 — the same discipline as
 * `chunkedJobStore.ts` — so two admins stepping the same job from two
 * browsers (or two replicas) never lose each other's item outcomes, and a
 * terminal status can never be overwritten by a late step.
 *
 * Nothing here touches Graph or the search index; the pure helpers at the
 * bottom (summaries, staleness, chunk diff) are exported for tests.
 */
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  AGENT_ACCESS_M365_JOBS_PREFIX,
  M365IndexJob,
  M365IndexJobSchema,
  M365IndexJobSource,
  M365SourceChanges,
  m365AgentIndexJobBlobPath,
} from '@/lib/services/agentAccess/types';

import { withAzureRetry } from '@/lib/utils/server/azure/retry';
import { BlobStorage } from '@/lib/utils/server/blob/blob';
import {
  sanitizeForLog,
  zodIssueSummary,
} from '@/lib/utils/server/log/logSanitization';

/**
 * A running job whose last write is older than this is "interrupted":
 * the browser driving it went away. Steps heartbeat far more often than
 * this (every claimed batch), so a live job can never look stale.
 */
export const STALE_INDEX_JOB_MS = 10 * 60_000;
const CAS_RETRIES = 4;

export interface IndexJobReadResult {
  job: M365IndexJob;
  etag: string;
}

export interface IndexJobMutateResult extends IndexJobReadResult {
  /** False when the mutator declined (returned null) — nothing was written. */
  changed: boolean;
}

export async function readIndexJob(
  storage: BlobStorage,
  agentId: string,
): Promise<IndexJobReadResult | null> {
  const result = await downloadBlob(
    storage,
    m365AgentIndexJobBlobPath(agentId),
    'agentAccess.readM365IndexJob',
  );
  if (result === null) return null;
  const parsed = M365IndexJobSchema.safeParse(
    JSON.parse(result.buffer.toString('utf8')),
  );
  if (!parsed.success) {
    // Derived data: a malformed job reads as "no job" so a fresh start
    // can overwrite it, but say so.
    console.error(
      `[m365-agents] ignoring malformed index job for ${sanitizeForLog(agentId)}: ${zodIssueSummary(parsed.error)}`,
    );
    return null;
  }
  return { job: parsed.data, etag: result.etag };
}

/** `ifMatchEtag` null → create-only (If-None-Match: *); '*' → unconditional. */
export async function writeIndexJob(
  storage: BlobStorage,
  job: M365IndexJob,
  ifMatchEtag: string | null,
): Promise<string> {
  const parsed = M365IndexJobSchema.parse(job);
  return uploadJson(
    storage,
    m365AgentIndexJobBlobPath(parsed.agentId),
    parsed,
    ifMatchEtag,
    'agentAccess.writeM365IndexJob',
  );
}

/**
 * Read-modify-write with bounded CAS retries. `mutate` returns the next
 * record, or null to leave the blob untouched (e.g. the job is already
 * terminal). Returns the record as finally written (or as found, when
 * the mutation was a no-op), or null when no job exists.
 */
export async function mutateIndexJob(
  storage: BlobStorage,
  agentId: string,
  mutate: (job: M365IndexJob) => M365IndexJob | null,
): Promise<IndexJobMutateResult | null> {
  for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
    const current = await readIndexJob(storage, agentId);
    if (!current) return null;
    const next = mutate(current.job);
    if (next === null) return { ...current, changed: false };
    try {
      const etag = await writeIndexJob(storage, next, current.etag);
      return { job: next, etag, changed: true };
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError)) throw error;
      // Another writer won; re-read and re-apply.
    }
  }
  throw new AgentAccessConflictError(
    'Index job was modified concurrently too many times',
  );
}

export async function deleteIndexJob(
  storage: BlobStorage,
  agentId: string,
): Promise<void> {
  await withAzureRetry(
    () => storage.deleteIfExists(m365AgentIndexJobBlobPath(agentId)),
    { label: 'agentAccess.deleteM365IndexJob' },
  );
}

/** All job records, keyed by agent id (for the admin listing). */
export async function listIndexJobs(
  storage: BlobStorage,
): Promise<Map<string, M365IndexJob>> {
  const names = await storage.listBlobs(AGENT_ACCESS_M365_JOBS_PREFIX);
  const jobs = new Map<string, M365IndexJob>();
  await Promise.all(
    names.map(async (name) => {
      const agentId = name
        .slice(AGENT_ACCESS_M365_JOBS_PREFIX.length)
        .replace(/\.json$/, '');
      if (!agentId) return;
      try {
        const result = await readIndexJob(storage, agentId);
        if (result && result.job.agentId === agentId) {
          jobs.set(agentId, result.job);
        }
      } catch (error) {
        console.warn(
          `[m365-agents] skipping unreadable index job ${sanitizeForLog(name)}: ${sanitizeForLog(error)}`,
        );
      }
    }),
  );
  return jobs;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isTerminalIndexJob(job: M365IndexJob): boolean {
  return job.status !== 'running';
}

export function isStaleIndexJob(job: M365IndexJob, now = Date.now()): boolean {
  return (
    job.status === 'running' &&
    now - Date.parse(job.updatedAt) > STALE_INDEX_JOB_MS
  );
}

/** What the admin UI shows: counts, not items. */
export interface IndexJobSummary {
  jobId: string;
  agentId: string;
  status: M365IndexJob['status'];
  mode: M365IndexJob['mode'];
  /** Refresh jobs: what changed since the last manifest. */
  changes?: M365SourceChanges;
  /** Running but no heartbeat for STALE_INDEX_JOB_MS — resumable. */
  stale: boolean;
  startedBy: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Indexable items in the plan. */
  total: number;
  /** Items with a final outcome. */
  done: number;
  indexed: number;
  failed: number;
  noText: number;
  missing: number;
  error?: string;
}

export function summarizeIndexJob(
  job: M365IndexJob,
  now = Date.now(),
): IndexJobSummary {
  const summary: IndexJobSummary = {
    jobId: job.jobId,
    agentId: job.agentId,
    status: job.status,
    mode: job.mode,
    ...(job.changes && { changes: job.changes }),
    stale: isStaleIndexJob(job, now),
    startedBy: job.startedBy,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    ...(job.finishedAt && { finishedAt: job.finishedAt }),
    total: 0,
    done: 0,
    indexed: 0,
    failed: 0,
    noText: 0,
    missing: 0,
    ...(job.error && { error: job.error }),
  };
  for (const source of job.sources) {
    for (const item of source.items) {
      if (item.tier !== 'indexable') continue;
      summary.total += 1;
      switch (item.status) {
        case 'indexed':
          summary.indexed += 1;
          summary.done += 1;
          break;
        case 'failed':
          summary.failed += 1;
          summary.done += 1;
          break;
        case 'noText':
          summary.noText += 1;
          summary.done += 1;
          break;
        case 'missing':
          summary.missing += 1;
          summary.done += 1;
          break;
        default:
          break;
      }
    }
  }
  return summary;
}

/** Items a step may still pick up. */
export function pendingIndexItems(
  job: M365IndexJob,
): { sourceId: string; itemId: string }[] {
  const pending: { sourceId: string; itemId: string }[] = [];
  for (const source of job.sources) {
    if (source.status !== 'pending') continue;
    for (const item of source.items) {
      if (
        item.tier === 'indexable' &&
        (item.status ?? 'pending') === 'pending'
      ) {
        pending.push({ sourceId: source.sourceId, itemId: item.itemId });
      }
    }
  }
  return pending;
}

/**
 * Items an interrupted step left `processing` go back to `pending` so a
 * resume re-attempts them (their uploads, if any happened, are idempotent
 * by chunk id).
 */
export function releaseProcessingItems(job: M365IndexJob): M365IndexJob {
  return {
    ...job,
    sources: job.sources.map((source) => ({
      ...source,
      items: source.items.map((item) =>
        item.status === 'processing' ? { ...item, status: 'pending' } : item,
      ),
    })),
  };
}

/**
 * The chunk ids the finished job says should exist, and the id prefixes
 * whose existing chunks must be KEPT even though the run didn't rewrite
 * them: items that failed or vanished this run (their previous chunks are
 * better than nothing, and retrieval is trimmed per item anyway) and
 * sources whose plan failed outright. Everything else in the index for
 * this agent is stale and gets deleted by the diff.
 */
export interface ChunkRetention {
  expected: Set<string>;
  keepPrefixes: string[];
}

export function chunkRetentionFor(
  job: M365IndexJob,
  sanitizeItemId: (id: string) => string,
): ChunkRetention {
  const expected = new Set<string>();
  const keepPrefixes: string[] = [];
  for (const source of job.sources) {
    if (source.status === 'error' || source.status === 'missing') {
      keepPrefixes.push(`${job.agentId}_${source.sourceId}_`);
      continue;
    }
    for (const item of source.items) {
      if (item.tier !== 'indexable') continue;
      const itemPrefix = `${job.agentId}_${source.sourceId}_${sanitizeItemId(item.itemId)}_`;
      if (item.status === 'indexed') {
        for (let i = 0; i < (item.indexedChunks ?? 0); i++) {
          expected.add(`${itemPrefix}${i}`);
        }
      } else if (
        item.status === 'failed' ||
        item.status === 'missing' ||
        item.status === 'pending' ||
        item.status === 'processing'
      ) {
        keepPrefixes.push(itemPrefix);
      }
      // noText: the document now has no text — its old chunks go.
    }
  }
  return { expected, keepPrefixes };
}

/** Chunk ids present in the index that the retention rules do not cover. */
export function selectStaleChunkIds(
  existing: Iterable<string>,
  retention: ChunkRetention,
): string[] {
  const stale: string[] = [];
  for (const id of existing) {
    if (retention.expected.has(id)) continue;
    if (retention.keepPrefixes.some((prefix) => id.startsWith(prefix))) {
      continue;
    }
    stale.push(id);
  }
  return stale;
}

/** Job sources → the agent's persisted manifest shape. */
export function jobSourcesToManifest(sources: M365IndexJobSource[]): {
  sourceId: string;
  truncated: boolean;
  deltaLink?: string;
  folders: M365IndexJobSource['folders'];
  items: M365IndexJobSource['items'];
}[] {
  return sources.map((source) => ({
    sourceId: source.sourceId,
    truncated: source.truncated,
    ...(source.deltaLink && { deltaLink: source.deltaLink }),
    folders: source.folders,
    items: source.items.map((item) =>
      item.status === 'processing' ? { ...item, status: 'pending' } : item,
    ),
  }));
}
