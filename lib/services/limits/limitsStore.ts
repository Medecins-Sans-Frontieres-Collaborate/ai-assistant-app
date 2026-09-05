/**
 * Blob persistence for the usage-limits policy and its audit history.
 *
 * ONE document (`system/limits/policy.json`), not per-override blobs. This is
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
 * Reads and parses the policy. Returns null when none has been written yet;
 * throws {@link PolicyUnreadableError} for a document that exists but cannot
 * be parsed, and propagates storage failures unchanged.
 */
export async function readPolicy(
  storage: BlobStorage,
): Promise<PolicyReadResult | null> {
  const result = await downloadBlob(
    storage,
    LIMITS_POLICY_PATH,
    'limits.readPolicy',
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
  const parsed = LimitsPolicySchema.parse(policy);
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
  }
}
