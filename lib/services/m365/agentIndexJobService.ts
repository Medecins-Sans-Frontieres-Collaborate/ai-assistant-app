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
  readM365AgentManifest,
  writeM365Agent,
  writeM365AgentManifest,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  OVERWRITE_BLOB,
  statusCodeOf,
} from '@/lib/services/agentAccess/blobCas';
import type {
  M365Agent,
  M365IndexJob,
  M365ManifestItem,
} from '@/lib/services/agentAccess/types';
import {
  readDerivedIndex,
  readDerivedText,
  writeDerivedText,
} from '@/lib/services/m365/agentDerivedTextStore';
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
import { withGraphTokenCache } from '@/lib/services/m365/graphApi';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

/**
 * Wall-clock budget per step. Well inside the route's maxDuration and any
 * ingress idle timeout; a batch that starts before the deadline runs to
 * completion, so a step can overrun by one slow document (batches shrink
 * to one document near the deadline — see SMALL_BATCH_THRESHOLD_MS).
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
  mode: 'full' | 'refresh' = 'full',
): Promise<IndexJobSummary> {
  const current = await readIndexJob(storage, agent.id);
  if (
    current &&
    !isTerminalIndexJob(current.job) &&
    !isStaleIndexJob(current.job)
  ) {
    throw new IndexJobActiveError(summarizeIndexJob(current.job));
  }
  // A refresh without a manifest (never indexed under the planner) is
  // simply a full run.
  const manifest =
    mode === 'refresh' ? await readM365AgentManifest(storage, agent.id) : null;
  const { index: derived } = await readDerivedIndex(storage, agent.id);
  // Planning walks every source with the admin's token: one mint per
  // request, not one per Graph page.
  const job = await withGraphTokenCache(req, () =>
    prepareIndexJob(req, agent, userId, userMail, {
      mode: manifest ? 'refresh' : 'full',
      manifest,
      prepared: derived.items,
    }),
  );
  // Replace whatever was there (terminal or interrupted). A concurrent
  // start loses the CAS and surfaces as a conflict to its caller. With no
  // readable record the write is unconditional: a malformed job blob must
  // be overwritable, and a create-only write would 409 against it.
  await writeIndexJob(storage, job, current?.etag ?? OVERWRITE_BLOB);
  // Source statuses are deliberately NOT touched here. Flipping them to
  // `indexing` (and to `pending` on failure) made a live agent vanish from
  // discovery the moment a re-run died, although its chunks were still in
  // the index; the job summary already carries the run's progress.
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
  const ocrPages = outcomes.reduce((n, o) => n + (o.item.ocrPages ?? 0), 0);
  return {
    ...job,
    updatedAt: now(),
    ocrPagesUsed: (job.ocrPagesUsed ?? 0) + ocrPages,
    sources: job.sources.map((source) => ({
      ...source,
      items: source.items.map(
        (item) => byKey.get(`${source.sourceId}:${item.itemId}`) ?? item,
      ),
    })),
  };
}

/**
 * Auto-OCR budget for one step, shared by every item of a batch (items
 * reserve pages synchronously before awaiting OCR, so three concurrent
 * scans cannot overspend the run cap together). Null when the agent has
 * auto-OCR off, or when the run's per-run page cap is already spent.
 */
export function autoOcrBudgetFor(
  agent: M365Agent | null,
  job: M365IndexJob,
): { remainingPages: number; maxPagesPerFile: number } | undefined {
  if (!agent?.autoOcr) return undefined;
  const remainingPages = Math.max(
    0,
    env.M365_AGENT_AUTO_OCR_MAX_PAGES_PER_RUN - (job.ocrPagesUsed ?? 0),
  );
  return {
    remainingPages,
    maxPagesPerFile: env.M365_AGENT_AUTO_OCR_MAX_PAGES_PER_FILE,
  };
}

/**
 * Human-readable reason for a step that died. Storage precondition
 * failures used to reach the admin as Azure's raw "The specified blob
 * already exists" — say what it means for them instead.
 */
export function describeStepFailure(error: unknown): string {
  const status = statusCodeOf(error);
  if (
    error instanceof AgentAccessConflictError ||
    status === 409 ||
    status === 412
  ) {
    return "Could not save the run's results because another write got there first — retry the run";
  }
  if (status !== undefined && status >= 500) {
    return `Storage or search service unavailable (${status}) — retry the run`;
  }
  return error instanceof Error ? error.message.slice(0, 300) : 'Step failed';
}

const SKIP_REASON_TEXT: Record<string, string> = {
  unsupported: 'unsupported file type',
  tooLarge: 'file too large',
  disallowedType: 'file type not allowed',
  malware: 'flagged as malware by Microsoft',
  zeroBytes: 'empty file',
  excluded: 'excluded by the subfolder selection',
  typeFilter: 'excluded by the file-type filter',
};

const SUPPORTED_ALTERNATIVES: Record<string, string> = {
  xlsm: '.xlsx',
  docm: '.docx',
  pptm: '.pptx',
  ppsx: '.pptx',
  odp: '.pptx',
  ods: '.xlsx',
  pages: '.docx',
  numbers: '.xlsx',
  key: '.pptx',
  msg: '.pdf',
  eml: '.pdf',
  one: '.pdf',
};

/**
 * Why a source produced no indexable document — in words an admin can act
 * on. A single skipped file names its type; a folder gives the counts.
 * Exported for tests.
 */
export function describeEmptySource(
  source: M365Agent['sources'][number],
  items: M365ManifestItem[],
): string {
  if (source.kind === 'file' && items.length === 1) {
    const [item] = items;
    const ext = item.name.includes('.')
      ? item.name.slice(item.name.lastIndexOf('.') + 1).toLowerCase()
      : '';
    if (item.tier === 'needsPreparation') {
      return `${item.name} needs preparation before it can be indexed — use Prepare in the source details`;
    }
    const reason = SKIP_REASON_TEXT[item.reason ?? ''] ?? 'not indexable';
    if (item.reason === 'unsupported' && ext) {
      const alternative = SUPPORTED_ALTERNATIVES[ext];
      return alternative
        ? `Unsupported file type (.${ext}) — save it as ${alternative} and index again`
        : `Unsupported file type (.${ext})`;
    }
    if (item.reason === 'unsupported') {
      return 'Unsupported file type (no extension)';
    }
    return `${item.name}: ${reason}`;
  }
  const counts = summarizeCounts(items);
  const parts: string[] = [];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.needsPreparation > 0) {
    parts.push(`${counts.needsPreparation} need preparation`);
  }
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return items.length === 0
    ? 'The folder contains no files'
    : `No supported files in this source${detail}`;
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
      // A source whose plan found nothing indexable (single unsupported
      // file, folder of skipped types) is an error the admin must act on,
      // not a successful run with zero chunks — "indexed" here used to
      // stamp lastIndexedAt and hide the reason behind a grey chip.
      // (finalize has already mapped a drained `pending` source to
      // `indexed`, so the check is on "not otherwise failed".)
      const nothingToIndex =
        jobSource.status !== 'missing' &&
        jobSource.status !== 'error' &&
        attempted === 0;
      const status =
        jobSource.status === 'missing'
          ? 'missing'
          : jobSource.status === 'error' || allFailed || nothingToIndex
            ? 'error'
            : 'indexed';
      const error =
        jobSource.error ??
        (nothingToIndex
          ? describeEmptySource(source, jobSource.items)
          : jobSource.items.find((i) => i.error)?.error);
      // Drop a stale timestamp on a source that no longer serves this run's
      // content; `lastIndexedAt` must mean "this source's files are in the
      // index as of then".
      const rest = { ...source };
      delete rest.lastIndexedAt;
      return {
        ...rest,
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
export function stepIndexJob(
  req: NextRequest,
  storage: BlobStorage,
  agentId: string,
  jobId: string,
  budgetMs = STEP_TIME_BUDGET_MS,
): Promise<IndexJobSummary> {
  // A step downloads several documents: mint the token once for all of them.
  return withGraphTokenCache(req, () =>
    runIndexJobStep(req, storage, agentId, jobId, budgetMs),
  );
}

/**
 * When the remaining step budget is below this, the next batch is a
 * single document: a full batch of three slow files could otherwise push
 * the step past the route's maxDuration (the client would see a dead
 * request while the server keeps working).
 */
export const SMALL_BATCH_THRESHOLD_MS = 15_000;

async function runIndexJobStep(
  req: NextRequest,
  storage: BlobStorage,
  agentId: string,
  jobId: string,
  budgetMs: number,
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
  let batches = 0;
  // The agent's auto-OCR choice is read once per step; the budget object
  // below is shared by every item processed in this step.
  const agentRecord =
    (await readM365Agent(storage, agentId))?.m365Agent ?? null;
  try {
    // At least one batch per step, then as many as the budget allows.
    do {
      // The mutator may run more than once (CAS retry); the claims from
      // the invocation whose write landed are the ones this step owns.
      let mine: ClaimedItem[] = [];
      // The first batch is always full (a step must make progress even on
      // a tiny budget); later batches shrink to one document when little
      // budget is left, so the step cannot overrun by three slow files.
      const remainingMs = budgetMs - (Date.now() - startedAt);
      const batchSize =
        batches === 0 || remainingMs >= SMALL_BATCH_THRESHOLD_MS
          ? DOCUMENT_INDEX_CONCURRENCY
          : 1;
      batches += 1;
      const claim = await mutateIndexJob(storage, agentId, (latest) => {
        if (latest.jobId !== jobId || isTerminalIndexJob(latest)) return null;
        const result = claimItems(latest, batchSize);
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

      const autoOcr = autoOcrBudgetFor(agentRecord, job);
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
            async (id) => {
              const derived = await readDerivedText(storage, agentId, id);
              return derived
                ? { eTag: derived.eTag, text: derived.text }
                : null;
            },
            autoOcr
              ? {
                  autoOcr,
                  // Cache what was paid for: the next run (or Re-index all)
                  // reads the derived text instead of OCR'ing again.
                  persistOcr: async (output) => {
                    await writeDerivedText(
                      storage,
                      {
                        version: 1,
                        agentId,
                        itemId: output.itemId,
                        eTag: output.eTag,
                        kind: 'pdfOcr',
                        preparedAt: now(),
                        model: `auto-ocr:${output.engine}`,
                        text: output.text,
                      },
                      output.name,
                    );
                  },
                }
              : undefined,
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
        error: describeStepFailure(error),
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
