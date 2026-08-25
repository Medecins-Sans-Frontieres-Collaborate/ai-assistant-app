/**
 * Orchestration for resumable M365 agent index jobs (seventh pass §4).
 *
 *   start   → plan every source with the admin's token, write the job
 *             (all indexable items `pending`), mark the agent `indexing`
 *   step    → claim a batch of pending items (CAS), process them with the
 *             caller's token, record outcomes (CAS); repeat until the time
 *             box expires or nothing is pending; the step that drains the
 *             job finalizes it
 *   cancel  → terminal `cancelled`; uploaded chunks stay (idempotent ids —
 *             the next run reconciles them)
 *   finalize→ diff-delete stale chunks, write the manifest, stamp per-source
 *             outcomes on the agent record, terminal `succeeded`
 *
 * Any admin holding the agent's key may step a job someone else started —
 * that is what makes an interrupted job resumable without offline tokens.
 */
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  readM365Agent,
  writeM365Agent,
  writeM365AgentManifest,
} from '@/lib/services/agentAccess/accessRulesStore';
import type {
  M365Agent,
  M365IndexJob,
  M365ManifestItem,
} from '@/lib/services/agentAccess/types';
import {
  IndexJobSummary,
  isStaleIndexJob,
  isTerminalIndexJob,
  jobSourcesToManifest,
  mutateIndexJob,
  pendingIndexItems,
  readIndexJob,
  releaseProcessingItems,
  summarizeIndexJob,
  writeIndexJob,
} from '@/lib/services/m365/agentIndexJobStore';
import {
  DOCUMENT_INDEX_CONCURRENCY,
  indexJobItem,
  mapWithConcurrency,
  prepareIndexJob,
  reconcileAgentChunks,
} from '@/lib/services/m365/agentIndexService';
import { summarizeCounts } from '@/lib/services/m365/agentSourcePlanner';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/**
 * Wall-clock budget per step. Well inside the route's maxDuration and any
 * ingress idle timeout; a batch that starts before the deadline runs to
 * completion, so a step can overrun by one slow document.
 */
export const STEP_TIME_BUDGET_MS = 45_000;

export class IndexJobActiveError extends Error {
  constructor(readonly summary: IndexJobSummary) {
    super('An index job is already running for this agent');
    this.name = 'IndexJobActiveError';
  }
}

export class IndexJobMismatchError extends Error {
  constructor() {
    super('The job id does not match the agent’s current job');
    this.name = 'IndexJobMismatchError';
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Best-effort: mark every source `indexing` while a job runs. */
async function markAgentSources(
  storage: BlobStorage,
  agentId: string,
  status: 'indexing' | 'pending',
  onlyFrom?: 'indexing',
): Promise<void> {
  try {
    const latest = await readM365Agent(storage, agentId);
    if (!latest) return;
    const updated: M365Agent = {
      ...latest.m365Agent,
      sources: latest.m365Agent.sources.map((source) =>
        onlyFrom && source.status !== onlyFrom ? source : { ...source, status },
      ),
    };
    await writeM365Agent(storage, updated, latest.etag);
    AgentAccessService.getInstance().invalidate();
  } catch (error) {
    if (!(error instanceof AgentAccessConflictError)) {
      console.warn(
        `[m365-agents] could not mark sources ${status} for ${sanitizeForLog(agentId)}: ${sanitizeForLog(error)}`,
      );
    }
  }
}

export async function startIndexJob(
  req: NextRequest,
  storage: BlobStorage,
  agent: M365Agent,
  userId: string,
  userMail: string,
): Promise<IndexJobSummary> {
  const current = await readIndexJob(storage, agent.id);
  if (
    current &&
    !isTerminalIndexJob(current.job) &&
    !isStaleIndexJob(current.job)
  ) {
    throw new IndexJobActiveError(summarizeIndexJob(current.job));
  }
  const job = await prepareIndexJob(req, agent, userId, userMail);
  // Replace whatever was there (terminal or interrupted). A concurrent
  // start loses the CAS and surfaces as a conflict to its caller.
  await writeIndexJob(storage, job, current?.etag ?? null);
  await markAgentSources(storage, agent.id, 'indexing');
  return summarizeIndexJob(job);
}

interface ClaimedItem {
  sourceId: string;
  item: M365ManifestItem;
}

function claimItems(
  job: M365IndexJob,
  limit: number,
): {
  job: M365IndexJob;
  claimed: ClaimedItem[];
} {
  const wanted = new Set(
    pendingIndexItems(job)
      .slice(0, limit)
      .map((p) => `${p.sourceId}:${p.itemId}`),
  );
  if (wanted.size === 0) return { job, claimed: [] };
  const claimed: ClaimedItem[] = [];
  const next: M365IndexJob = {
    ...job,
    updatedAt: now(),
    sources: job.sources.map((source) => ({
      ...source,
      items: source.items.map((item) => {
        if (!wanted.has(`${source.sourceId}:${item.itemId}`)) return item;
        const processing = { ...item, status: 'processing' as const };
        claimed.push({ sourceId: source.sourceId, item: processing });
        return processing;
      }),
    })),
  };
  return { job: next, claimed };
}

function recordOutcomes(
  job: M365IndexJob,
  outcomes: ClaimedItem[],
): M365IndexJob {
  const byKey = new Map(
    outcomes.map((o) => [`${o.sourceId}:${o.item.itemId}`, o.item]),
  );
  return {
    ...job,
    updatedAt: now(),
    sources: job.sources.map((source) => ({
      ...source,
      items: source.items.map(
        (item) => byKey.get(`${source.sourceId}:${item.itemId}`) ?? item,
      ),
    })),
  };
}

/** Stamps per-source outcomes onto the agent record after a finished job. */
function applyJobToAgent(
  agent: M365Agent,
  job: M365IndexJob,
  finishedAt: string,
): M365Agent {
  const bySourceId = new Map(job.sources.map((s) => [s.sourceId, s]));
  return {
    ...agent,
    // Retrieval embeds queries with this value; it must match the index.
    embeddingModelId: job.embeddingDeployment,
    sources: agent.sources.map((source) => {
      const jobSource = bySourceId.get(source.sourceId);
      if (!jobSource) return source;
      const counts = summarizeCounts(jobSource.items);
      const attempted = counts.indexable;
      const failed = (counts.failed ?? 0) + (counts.missing ?? 0);
      const allFailed = attempted > 0 && failed === attempted;
      const status =
        jobSource.status === 'missing'
          ? 'missing'
          : jobSource.status === 'error' || allFailed
            ? 'error'
            : 'indexed';
      const error =
        jobSource.error ?? jobSource.items.find((i) => i.error)?.error;
      return {
        ...source,
        status,
        indexedChunks: jobSource.items.reduce(
          (n, i) => n + (i.indexedChunks ?? 0),
          0,
        ),
        counts,
        ...(jobSource.deltaLink && { deltaLink: jobSource.deltaLink }),
        ...(status === 'indexed' && { lastIndexedAt: finishedAt }),
        error,
      };
    }),
  };
}

/**
 * The last step's work: reconcile the index, persist the manifest, stamp
 * the agent, mark the job terminal. Each part is retried by the next step
 * if this one dies (the job stays `running` with nothing pending until
 * the terminal write lands).
 */
async function finalizeIndexJob(
  storage: BlobStorage,
  job: M365IndexJob,
): Promise<M365IndexJob> {
  const finishedAt = now();
  const sources = job.sources.map((source) => ({
    ...source,
    status: source.status === 'pending' ? ('indexed' as const) : source.status,
  }));
  const finished: M365IndexJob = { ...job, sources };

  const removed = await reconcileAgentChunks(finished);
  console.log(
    `[m365-agents] job ${sanitizeForLog(job.jobId)} reconciled index for ${sanitizeForLog(job.agentId)}: ${removed} stale chunks removed`,
  );

  await writeM365AgentManifest(storage, {
    version: 1,
    agentId: job.agentId,
    updatedAt: finishedAt,
    sources: jobSourcesToManifest(finished.sources),
  });

  // Stamp the LATEST agent record (an admin may have edited it meanwhile;
  // outcomes attach by stable sourceId). A CAS loss here is retried once
  // by re-reading; after that the manifest is still correct and the next
  // run converges the annotations.
  for (let attempt = 0; attempt < 2; attempt++) {
    const latest = await readM365Agent(storage, job.agentId);
    if (!latest) break;
    try {
      await writeM365Agent(
        storage,
        applyJobToAgent(latest.m365Agent, finished, finishedAt),
        latest.etag,
      );
      break;
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError)) throw error;
    }
  }
  AgentAccessService.getInstance().invalidate();

  const terminal =
    (await mutateIndexJob(storage, job.agentId, (current) => {
      if (current.jobId !== job.jobId || isTerminalIndexJob(current)) {
        return null;
      }
      return {
        ...finished,
        status: 'succeeded',
        updatedAt: finishedAt,
        finishedAt,
      };
    })) ?? null;
  return terminal?.job ?? { ...finished, status: 'succeeded', finishedAt };
}

/**
 * Runs one time-boxed step of the agent's current job and returns its
 * progress. Safe to call from several browsers at once: claims and
 * outcomes go through CAS, so two steppers simply share the work.
 */
export async function stepIndexJob(
  req: NextRequest,
  storage: BlobStorage,
  agentId: string,
  jobId: string,
  budgetMs = STEP_TIME_BUDGET_MS,
): Promise<IndexJobSummary> {
  const startedAt = Date.now();

  // Resume: an interrupted step's claims go back to pending.
  let current = await mutateIndexJob(storage, agentId, (job) => {
    if (job.jobId !== jobId) throw new IndexJobMismatchError();
    if (isTerminalIndexJob(job)) return null;
    if (!isStaleIndexJob(job)) return null;
    return { ...releaseProcessingItems(job), updatedAt: now() };
  });
  if (!current) throw new IndexJobMismatchError();
  if (isTerminalIndexJob(current.job)) return summarizeIndexJob(current.job);

  let job = current.job;
  try {
    // At least one batch per step, then as many as the budget allows.
    do {
      // The mutator may run more than once (CAS retry); the claims from
      // the invocation whose write landed are the ones this step owns.
      let mine: ClaimedItem[] = [];
      const claim = await mutateIndexJob(storage, agentId, (latest) => {
        if (latest.jobId !== jobId || isTerminalIndexJob(latest)) return null;
        const result = claimItems(latest, DOCUMENT_INDEX_CONCURRENCY);
        mine = result.claimed;
        return result.job;
      });
      if (!claim) throw new IndexJobMismatchError();
      job = claim.job;
      if (isTerminalIndexJob(job)) return summarizeIndexJob(job);

      if (mine.length === 0) {
        // Nothing pending anywhere. Another stepper may still be working
        // on its claims; only the step that sees no `processing` items
        // either finalizes — the other one returns progress and the
        // browser polls again.
        const inFlight = job.sources.some((s) =>
          s.items.some((i) => i.status === 'processing'),
        );
        if (inFlight) {
          if (isStaleIndexJob(job)) {
            // Those claims belong to a dead stepper: release and retry.
            await mutateIndexJob(storage, agentId, (latest) =>
              latest.jobId === jobId && !isTerminalIndexJob(latest)
                ? { ...releaseProcessingItems(latest), updatedAt: now() }
                : null,
            );
            continue;
          }
          return summarizeIndexJob(job);
        }
        // Nothing pending anywhere: this step finalizes.
        job = await finalizeIndexJob(storage, job);
        return summarizeIndexJob(job);
      }

      const outcomes = await mapWithConcurrency(
        mine,
        DOCUMENT_INDEX_CONCURRENCY,
        async ({ sourceId, item }) => ({
          sourceId,
          item: await indexJobItem(
            req,
            agentId,
            job.embeddingDeployment,
            sourceId,
            item,
          ),
        }),
      );

      const recorded = await mutateIndexJob(storage, agentId, (latest) => {
        if (latest.jobId !== jobId || isTerminalIndexJob(latest)) return null;
        return recordOutcomes(latest, outcomes);
      });
      if (!recorded) throw new IndexJobMismatchError();
      job = recorded.job;
      if (isTerminalIndexJob(job)) return summarizeIndexJob(job);
    } while (Date.now() - startedAt < budgetMs);
  } catch (error) {
    if (error instanceof IndexJobMismatchError) throw error;
    // Session-level Graph failures (token gone, consent revoked) and
    // storage outages end the job loudly rather than looping.
    console.error(
      `[m365-agents] index job ${sanitizeForLog(jobId)} step failed: ${sanitizeForLog(error)}`,
    );
    const failed = await mutateIndexJob(storage, agentId, (latest) => {
      if (latest.jobId !== jobId || isTerminalIndexJob(latest)) return null;
      return {
        ...releaseProcessingItems(latest),
        status: 'failed',
        updatedAt: now(),
        finishedAt: now(),
        error:
          error instanceof Error ? error.message.slice(0, 300) : 'Step failed',
      };
    });
    await markAgentSources(storage, agentId, 'pending', 'indexing');
    return summarizeIndexJob(failed?.job ?? job);
  }
  return summarizeIndexJob(job);
}

export async function cancelIndexJob(
  storage: BlobStorage,
  agentId: string,
  jobId: string,
): Promise<IndexJobSummary | null> {
  const result = await mutateIndexJob(storage, agentId, (job) => {
    if (job.jobId !== jobId) throw new IndexJobMismatchError();
    if (isTerminalIndexJob(job)) return null;
    return {
      ...releaseProcessingItems(job),
      status: 'cancelled',
      updatedAt: now(),
      finishedAt: now(),
    };
  });
  if (!result || !result.changed) return null;
  await markAgentSources(storage, agentId, 'pending', 'indexing');
  return summarizeIndexJob(result.job);
}

export async function getIndexJobSummary(
  storage: BlobStorage,
  agentId: string,
): Promise<IndexJobSummary | null> {
  const result = await readIndexJob(storage, agentId);
  return result ? summarizeIndexJob(result.job) : null;
}
