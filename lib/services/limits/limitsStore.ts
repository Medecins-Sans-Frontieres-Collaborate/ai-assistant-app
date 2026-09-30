/**
 * Blob persistence for the usage-limits policy and its audit history.
 *
 * ONE document (`system/limits/policy.json`; `policy.beta.json` on beta — see
 * the carve-out note in lib/services/limits/types.ts), not per-override
 * blobs. This is
 * the single most important structural choice here: with per-override blobs a
 * malformed record fails OPEN — that user silently becomes unlimited, and
 * nobody finds out. With one document a parse failure is loud, total, and
 * falls to the explicit `failMode`. There is no path where one corrupt record
 * un-limits one person.
 *
 * The cost is admin-vs-admin CAS contention (handled by the 409-reload UX)
 * and a size ceiling, which the route's write schema bounds. Stable
 * per-override ids make a later split into `system/limits/overrides/<id>.json`
 * purely additive if that wall is ever hit.
 *
 * Scoped admins (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §5) write through the
 * SAME single document: each per-override save is a read-modify-write under
 * CAS (`mutatePolicy`) rather than a per-delegation blob, precisely because a
 * per-delegation blob would reintroduce the fail-open corrupt-record path
 * this header exists to rule out. The mutator is re-run against a FRESH read
 * on every 412 so it can re-validate (the delegation may have been narrowed,
 * disabled or deleted in between) — never compute once and re-upload.
 *
 * ⚠ Lives beside `system/agent-access/`, never underneath its `rules/`
 * prefix: `listAllRules` is fail-closed, so an alien blob there would brick
 * every Foundry agent invocation.
 *
 * CAS discipline (why `AzureBlobStorage.upload()` must never be used) lives
 * in lib/services/agentAccess/blobCas.ts.
 */
import { createAdminBlobStorage } from '@/lib/services/adminBlobStorage';
import {
  AgentAccessConflictError,
  downloadBlob,
  uploadJson,
} from '@/lib/services/agentAccess/blobCas';
import {
  DelegationsReadResult,
  DelegationsUnreadableError,
  readDelegationsDocument,
  writeDelegationsDocument,
} from '@/lib/services/delegations/delegationsStore';
import {
  DelegationsDocument,
  fromLegacyLimitDelegations,
  toLimitDelegations,
} from '@/lib/services/delegations/types';
import {
  LIMITS_HISTORY_PREFIX,
  LIMITS_POLICY_PATH,
  LimitsHistoryEntry,
  LimitsHistoryEntrySchema,
  LimitsPolicy,
  LimitsPolicySchema,
  historyBlobPath,
  scopedHistoryBlobPath,
} from '@/lib/services/limits/types';

import { BlobStorage } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

export { AgentAccessConflictError as LimitsConflictError };

/**
 * Counters and policy live in the centralized ADMIN storage (EU account,
 * dedicated lifecycle-free container) shared by every admin/system store —
 * one location for all users, so an org-wide total stays readable and the
 * per-user usage documents (Entra oid + integers) stay EU-resident. See
 * lib/services/adminBlobStorage.ts for the full rationale.
 */
export function createLimitsBlobStorage(): BlobStorage {
  return createAdminBlobStorage();
}

export interface PolicyReadResult {
  policy: LimitsPolicy;
  /** Raw (quoted) Azure ETag — echoed to admin clients for If-Match CAS. */
  etag: string;
}

/**
 * The stored policy document was downloaded but could not be turned into a
 * `LimitsPolicy` — not JSON, or JSON the read schema rejects. ONE typed
 * error for both halves so every caller classifies "the policy is
 * unavailable" by ORIGIN rather than by guessing at error classes: a
 * `SyntaxError` from `JSON.parse` carries neither an Azure status nor a Node
 * `code`, and would otherwise fall through to a generic 500 that the client
 * attributes to the admin's own edit (design §8 wants "unavailable, retry").
 * A storage failure (Azure status, network code) is NOT wrapped — it keeps
 * its own shape for `statusCodeOf` and the retry helpers.
 */
export class PolicyUnreadableError extends Error {
  constructor(cause: unknown) {
    super(
      `Stored limits policy is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'PolicyUnreadableError';
  }
}

/**
 * Reads and parses the STORED policy document, exactly as persisted — no
 * delegations composed in. Only this module and the migration below want
 * that; everything else reads through {@link readPolicy}.
 */
async function readStoredPolicy(
  storage: BlobStorage,
  options: { abortSignal?: AbortSignal } = {},
): Promise<PolicyReadResult | null> {
  const result = await downloadBlob(
    storage,
    LIMITS_POLICY_PATH,
    'limits.readPolicy',
    options,
  );
  if (result === null) return null;
  let policy: LimitsPolicy;
  try {
    policy = LimitsPolicySchema.parse(
      JSON.parse(result.buffer.toString('utf8')),
    );
  } catch (error) {
    throw new PolicyUnreadableError(error);
  }
  return { policy, etag: result.etag };
}

const MIGRATION_AUTHOR = 'system:delegations-migration';

/**
 * The shared delegations document, created on first need.
 *
 * Delegations used to live inside the limits policy; they are now a category
 * of their own (lib/services/delegations/types.ts). When the shared document
 * does not exist yet it is built ONCE from the policy's legacy
 * `delegations` and written create-only (`If-None-Match: *`), so two
 * replicas racing here cannot both win — the loser re-reads the winner's
 * document. The legacy copy is then stripped from the policy; that strip is
 * best-effort because {@link writePolicy} never persists delegations again,
 * so any later policy write finishes the job.
 *
 * Shared document FIRST, strip SECOND: a crash in between leaves a stale
 * copy in the policy that nothing reads.
 *
 * `legacy` lets {@link readPolicy} hand over the policy it has already
 * downloaded instead of paying for a second read.
 */
export async function loadDelegationsDocument(
  storage: BlobStorage,
  options: {
    abortSignal?: AbortSignal;
    legacy?: PolicyReadResult | null;
  } = {},
): Promise<DelegationsReadResult & { strippedPolicyEtag?: string }> {
  const existing = await readDelegationsDocument(storage, {
    abortSignal: options.abortSignal,
  });
  if (existing) return existing;

  const legacy =
    options.legacy !== undefined
      ? options.legacy
      : await readStoredPolicy(storage, { abortSignal: options.abortSignal });
  const now = new Date().toISOString();
  const document: DelegationsDocument = fromLegacyLimitDelegations(
    legacy?.policy.delegations ?? [],
    MIGRATION_AUTHOR,
    now,
  );

  let etag: string;
  try {
    etag = await writeDelegationsDocument(storage, document, null);
  } catch (error) {
    if (!(error instanceof AgentAccessConflictError)) throw error;
    // Another replica created it between our read and our write.
    const winner = await readDelegationsDocument(storage, {
      abortSignal: options.abortSignal,
    });
    if (winner) return winner;
    throw error;
  }
  console.log(
    `[delegations] migrated ${document.delegations.length} delegation(s) out of the limits policy into the shared document`,
  );

  // The strip REWRITES the policy blob, so the ETag the caller read is stale
  // the moment it succeeds; hand the new one back or the admin's next save
  // would be refused with a spurious 409.
  let strippedPolicyEtag: string | undefined;
  if (legacy && legacy.policy.delegations.length > 0) {
    try {
      strippedPolicyEtag = await uploadJson(
        storage,
        LIMITS_POLICY_PATH,
        LimitsPolicySchema.parse({ ...legacy.policy, delegations: [] }),
        legacy.etag,
        'limits.stripLegacyDelegations',
      );
    } catch (error) {
      // A concurrent policy write (412) strips them itself; anything else is
      // retried implicitly by the next policy write.
      console.warn(
        `[delegations] legacy delegations not stripped from the policy yet (harmless, ignored on read): ${sanitizeForLog(error)}`,
      );
    }
  }
  return {
    document,
    etag,
    ...(strippedPolicyEtag ? { strippedPolicyEtag } : {}),
  };
}

/**
 * Reads the policy and COMPOSES the shared delegations into it, so the
 * resolver, the scoped write path, the admin-auth decision and the save-time
 * verdicts all keep consuming `policy.delegations` unchanged. Returns null
 * when no policy has been written yet — delegations alone never create one
 * (a stored policy enforces, and delegating another capability must not
 * switch limits on).
 *
 * Throws {@link PolicyUnreadableError} for a policy OR a delegations document
 * that exists but cannot be parsed: a policy whose scoped overrides cannot be
 * evaluated is unavailable as a whole and falls to the explicit `failMode`,
 * never to "no scoped overrides". Storage failures propagate unchanged.
 */
export async function readPolicy(
  storage: BlobStorage,
  options: { abortSignal?: AbortSignal } = {},
): Promise<PolicyReadResult | null> {
  const stored = await readStoredPolicy(storage, options);
  if (stored === null) return null;
  let delegations: DelegationsReadResult & { strippedPolicyEtag?: string };
  try {
    delegations = await loadDelegationsDocument(storage, {
      abortSignal: options.abortSignal,
      legacy: stored,
    });
  } catch (error) {
    if (error instanceof DelegationsUnreadableError) {
      throw new PolicyUnreadableError(error);
    }
    throw error;
  }
  return {
    policy: {
      ...stored.policy,
      delegations: toLimitDelegations(delegations.document),
    },
    etag: delegations.strippedPolicyEtag ?? stored.etag,
  };
}

/**
 * Compare-and-swap policy write. `ifMatchEtag` null → creation only
 * (`If-None-Match: *`). 412 → {@link AgentAccessConflictError}, which the
 * route maps to 409. Returns the new ETag.
 */
export async function writePolicy(
  storage: BlobStorage,
  policy: LimitsPolicy,
  ifMatchEtag: string | null,
): Promise<string> {
  // Delegations are composed in on read and owned by the shared document
  // (loadDelegationsDocument): they are never persisted here again, which is
  // also what retires a legacy copy the migration could not strip.
  const parsed = LimitsPolicySchema.parse({ ...policy, delegations: [] });
  return uploadJson(
    storage,
    LIMITS_POLICY_PATH,
    parsed,
    ifMatchEtag,
    'limits.writePolicy',
  );
}

const POLICY_CAS_ATTEMPTS = 3;
const POLICY_CAS_BASE_BACKOFF_MS = 25;

/** What a {@link PolicyMutator} hands back: the document to write, or a stop. */
export interface PolicyMutationAbort {
  /** The HTTP response the route should return instead of writing. */
  abort: Response;
}
export type PolicyMutationOutcome = LimitsPolicy | PolicyMutationAbort;

/**
 * Receives the CURRENT stored policy (null when none exists yet) and its
 * ETag on EVERY attempt, so validation runs against fresh data each time.
 * Must not mutate `current` in place — return a new document.
 */
export type PolicyMutator = (
  current: LimitsPolicy | null,
  etag: string | null,
) => PolicyMutationOutcome | Promise<PolicyMutationOutcome>;

export interface MutatePolicyOptions {
  /** CAS rounds before giving up (default 3). */
  attempts?: number;
  /** Base for the jittered exponential backoff between rounds (default 25 ms; 0 disables). */
  backoffMs?: number;
  /** Log label. */
  label?: string;
}

export type MutatePolicyResult =
  | { policy: LimitsPolicy; etag: string; abort?: undefined }
  | { policy?: undefined; etag?: undefined; abort: Response };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded read-modify-write of the policy under CAS — the scoped write
 * path's primitive (design §5). Reads storage DIRECTLY (never the ≤60 s
 * LimitsService snapshot, or every write would burn a guaranteed 412),
 * invokes `mutate(current, etag)`, and writes the returned document with the
 * ETag it was derived from. On a 412 it re-reads and re-invokes the mutator;
 * after `attempts` rounds it throws {@link LimitsConflictError}, which routes
 * map to 409. A mutator that returns `{ abort }` stops the loop without
 * writing and the response is handed back verbatim. Read/parse failures
 * propagate unchanged. Callers still `LimitsService.getInstance().invalidate()`
 * and write history themselves, as the full PUT does.
 */
export async function mutatePolicy(
  storage: BlobStorage,
  mutate: PolicyMutator,
  opts: MutatePolicyOptions = {},
): Promise<MutatePolicyResult> {
  const attempts = Math.max(
    1,
    Math.floor(opts.attempts ?? POLICY_CAS_ATTEMPTS),
  );
  const backoffBase = opts.backoffMs ?? POLICY_CAS_BASE_BACKOFF_MS;
  const label = opts.label ?? 'limits.mutatePolicy';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const current = await readPolicy(storage);
    const outcome = await mutate(
      current?.policy ?? null,
      current?.etag ?? null,
    );
    if (!('version' in outcome)) return { abort: outcome.abort };
    const next = LimitsPolicySchema.parse(outcome);
    try {
      const etag = await writePolicy(storage, next, current?.etag ?? null);
      return { policy: next, etag };
    } catch (error) {
      if (!(error instanceof AgentAccessConflictError)) throw error;
      if (attempt >= attempts) {
        console.warn(
          `[limits-admin] ${label}: CAS exhausted after ${attempts} attempts`,
        );
        throw error;
      }
      if (backoffBase > 0) {
        // Jittered so two replicas that collided do not retry in lockstep.
        await sleep(backoffBase * 2 ** (attempt - 1) * (0.5 + Math.random()));
      }
    }
  }
  // Unreachable: the loop returns or throws on its last round.
  throw new AgentAccessConflictError();
}

/**
 * Immutable audit copy of every successful policy write. Best-effort by
 * design: a history failure must never fail the write the admin just made,
 * but it IS logged loudly. Written create-only, so a 412 (same timestamp and
 * author, i.e. a retry) is idempotent success rather than an error. Entries
 * that name an `overrideId` (scoped actions) use the per-override path so
 * two saves in one millisecond cannot collide.
 */
export async function writeHistoryEntry(
  storage: BlobStorage,
  entry: LimitsHistoryEntry,
): Promise<void> {
  const parsed = LimitsHistoryEntrySchema.parse(entry);
  const blobPath = parsed.overrideId
    ? scopedHistoryBlobPath(
        parsed.updatedAt,
        parsed.updatedBy,
        parsed.overrideId,
      )
    : historyBlobPath(parsed.updatedAt, parsed.updatedBy);
  try {
    await uploadJson(storage, blobPath, parsed, null, 'limits.writeHistory');
  } catch (error) {
    if (error instanceof AgentAccessConflictError) return;
    console.error(
      `[limits-admin] HISTORY WRITE FAILED by=${sanitizeForLog(parsed.updatedBy)}: ${sanitizeForLog(error)}`,
    );
    return;
  }
  await pruneHistory(storage);
}

/**
 * How many full-policy snapshots the audit trail keeps. Every write — the
 * global PUT and every per-override scoped save — stores one, the admin
 * container has no lifecycle rule (by design: admin data must not expire
 * silently), and nothing ever read the prefix back, so it grew without
 * bound. A count, not an age: a quiet policy keeps its last N changes
 * however old they are, and a busy one cannot fill the container.
 */
export const HISTORY_RETAIN = 200;

/**
 * Best-effort trim of `system/limits/history/` to the newest
 * {@link HISTORY_RETAIN} entries, ordered by the blob's own lastModified
 * (the path embeds the write timestamp but is only lexically sortable
 * within one format). Runs after a successful history write; a listing or
 * delete failure is logged and never surfaces to the admin's save.
 */
export async function pruneHistory(storage: BlobStorage): Promise<number> {
  try {
    const blobs = await storage.listBlobsDetailed(LIMITS_HISTORY_PREFIX);
    if (blobs.length <= HISTORY_RETAIN) return 0;
    const stale = [...blobs]
      .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
      .slice(HISTORY_RETAIN);
    let removed = 0;
    for (const blob of stale) {
      if (await storage.deleteIfExists(blob.name)) removed += 1;
    }
    return removed;
  } catch (error) {
    console.error(
      `[limits-admin] history prune failed (non-fatal): ${sanitizeForLog(error)}`,
    );
    return 0;
  }
}
