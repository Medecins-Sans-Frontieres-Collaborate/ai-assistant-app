import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { statusCodeOf } from '@/lib/services/agentAccess/blobCas';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import {
  LimitsConflictError,
  PolicyMutationOutcome,
  PolicyUnreadableError,
  createLimitsBlobStorage,
  mutatePolicy,
  writeHistoryEntry,
} from '@/lib/services/limits/limitsStore';
import {
  MAX_OVERRIDES,
  OVERRIDE_ID_RE,
  clampToHardCeilings,
  formatIssues,
  scopedOverrideBodySchema,
} from '@/lib/services/limits/policyWriteSchema';
import { resolveScopedCaller } from '@/lib/services/limits/scopedAccess';
import {
  TargetVerdict,
  countRaises,
  judgeTargets,
  outOfScopeTargets,
} from '@/lib/services/limits/scopedVerdicts';
import {
  DELEGATION_ID_RE,
  LimitOverride,
  LimitsPolicy,
} from '@/lib/services/limits/types';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';

/**
 * PUT/DELETE /api/limits/scoped/overrides/[id]?delegation=del-… — a scoped
 * admin's per-override write path (docs/LIMITS_SCOPED_ADMINS_DESIGN.md §4,
 * §5, §7).
 *
 * The caller never sees or supplies an ETag: each mutation is a bounded
 * read-modify-write of the ONE policy document under CAS (`mutatePolicy`),
 * and EVERY validation below runs again against the fresh read on every CAS
 * round — the delegation may have been narrowed, disabled or deleted,
 * `maxOverrides` lowered, or the target override deleted by a global admin
 * in between. A replace or delete of an override that vanished mid-way
 * answers 404, never resurrects it.
 *
 * Closed by shape, not by intent: the body schema is strict and carries no
 * `delegationId` / `priority ≠ 0` / `ceiling: true` / `createdBy`; the
 * delegation comes from the query parameter and must be one the caller is
 * named in and that is enabled; the path id must equal the body id; an
 * existing override with a different or absent `delegationId` is 403 and is
 * never overwritten; the splice touches exactly one element of `overrides`
 * and no other key. Save-time verdicts (§4) refuse targets PROVABLY outside
 * the jurisdiction and log the attempt — but containment is the resolver's,
 * so a target that slips through as "undecidable" still cannot reach anyone
 * outside the jurisdiction at runtime.
 *
 * Authorize BEFORE any id lookup (CWE-203): `authorize()` admits any
 * signed-in user with a mail, so both mutators resolve the caller first and
 * answer a principal who is neither a global admin nor named in any
 * delegation with one uniform 403 — before the delegation or override id is
 * looked up. Past that gate a scoped admin still cannot tell "not stored"
 * from "stored, but not under one of my delegations": PUT answers 403 for an
 * unknown delegation id exactly as for a foreign one (only a global admin,
 * who reads the whole document anyway, gets the 400), and DELETE answers
 * 403 LIMITS_FOREIGN_OVERRIDE for an unknown, global-tier and foreign id
 * alike. The only 404 is an OWNED record that vanished between CAS rounds.
 */

interface RouteContext {
  params: Promise<{ id: string }>;
}

function conflictResponse() {
  return errorResponse(
    'Limits policy was modified by another admin; retry',
    409,
    undefined,
    'LIMITS_CONFLICT',
  );
}

function policyUnavailableResponse() {
  return errorResponse(
    'Limits policy is unavailable; retry',
    503,
    undefined,
    'LIMITS_POLICY_UNAVAILABLE',
  );
}

function foreignOverrideResponse() {
  return errorResponse(
    'This override is not under your delegation',
    403,
    undefined,
    'LIMITS_FOREIGN_OVERRIDE',
  );
}

function budgetResponse(details: string) {
  return errorResponse(
    'Override budget exceeded',
    400,
    details,
    'LIMITS_BUDGET_EXCEEDED',
  );
}

/** Design §4: the refused targets travel as structured `details`. */
function outOfScopeResponse(outOfScope: string[]) {
  return errorResponse(
    'One or more targets are outside your scope',
    400,
    { outOfScope },
    'LIMITS_OUT_OF_SCOPE',
  );
}

/**
 * A `readPolicy` that lost its ETag (`downloadBlob` falls back to '') cannot
 * anchor a CAS write: `uploadJson` would treat '' as create-only and 412
 * forever, burning every retry into a misleading 409. Fail loud instead.
 */
function assertEtag(etag: string | null): void {
  if (etag === '') {
    throw new Error('Stored limits policy returned no ETag; refusing to write');
  }
}

async function authorize(
  id: string,
): Promise<
  { ok: true; user: Session['user'] } | { ok: false; response: Response }
> {
  const session = await auth();
  if (!session?.user) return { ok: false, response: unauthorizedResponse() };
  if (!session.user.mail?.trim()) {
    return { ok: false, response: forbiddenResponse() };
  }
  if (!OVERRIDE_ID_RE.test(id)) {
    return {
      ok: false,
      response: badRequestResponse('id is not a valid override id'),
    };
  }
  return { ok: true, user: session.user };
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const authz = await authorize(id);
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const userMail = user.mail!.trim().toLowerCase();

  const delegationId = request.nextUrl.searchParams.get('delegation') ?? '';
  if (!DELEGATION_ID_RE.test(delegationId)) {
    return badRequestResponse('delegation must be a valid delegation id');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = scopedOverrideBodySchema.safeParse(raw);
  if (!parsed.success) {
    return badRequestResponse('Invalid override', formatIssues(parsed.error));
  }
  const body = parsed.data;
  if (body.id !== id) {
    return badRequestResponse('Body id must equal the path id');
  }

  const now = new Date().toISOString();
  let written: LimitOverride | undefined;
  let verdicts: TargetVerdict[] = [];
  let raises = 0;
  /** Whether the FIRST round saw the override — a later miss means it vanished. */
  let sawExisting: boolean | undefined;

  const mutate = (
    current: LimitsPolicy | null,
    etag: string | null,
  ): PolicyMutationOutcome => {
    // No document → no delegation can exist, and a scoped admin must never
    // be the one who creates the policy from their own body.
    if (!current) return { abort: forbiddenResponse() };
    assertEtag(etag);

    const caller = resolveScopedCaller(user, current);
    if (!caller.isGlobalAdmin && caller.visible.length === 0) {
      return { abort: forbiddenResponse() };
    }
    // Looked up among the caller's OWN delegations: an id they are not named
    // in answers the same 403 whether it exists, is disabled, or never was.
    const delegation = caller.visible.find((d) => d.id === delegationId);
    if (!delegation) {
      if (
        caller.isGlobalAdmin &&
        !current.delegations.some((d) => d.id === delegationId)
      ) {
        return { abort: badRequestResponse('Unknown delegation') };
      }
      return {
        abort: forbiddenResponse('You are not an admin of this delegation'),
      };
    }
    if (!caller.writable.has(delegation.id)) {
      return { abort: forbiddenResponse('This delegation is disabled') };
    }

    const existing = current.overrides.find((o) => o.id === id);
    if (existing && existing.delegationId !== delegation.id) {
      return { abort: foreignOverrideResponse() };
    }
    if (sawExisting === undefined) sawExisting = existing !== undefined;
    else if (sawExisting && !existing) {
      return { abort: notFoundResponse('Override') };
    }

    verdicts = judgeTargets(delegation.jurisdiction, body.scope, body.targets);
    const outOfScope = outOfScopeTargets(verdicts);
    if (outOfScope.length > 0) {
      console.warn(
        `[limits-admin] action=scoped-rejected delegation=${sanitizeForLog(delegation.id)} override=${sanitizeForLog(id)} by=${sanitizeForLog(userMail)} outOfScope=${outOfScope.length}`,
      );
      return { abort: outOfScopeResponse(outOfScope) };
    }

    // Budget: the delegation's share, then the document total (so the NEXT
    // global PUT can still pass its own 200-override schema). Replacing an
    // existing record never changes either count, so it is always allowed —
    // a lowered `maxOverrides` blocks additions, not edits.
    if (!existing) {
      const owned = current.overrides.filter(
        (o) => o.delegationId === delegation.id,
      ).length;
      if (owned + 1 > delegation.maxOverrides) {
        return {
          abort: budgetResponse(
            `${owned}/${delegation.maxOverrides} overrides used by this delegation`,
          ),
        };
      }
      if (current.overrides.length + 1 > MAX_OVERRIDES) {
        return {
          abort: budgetResponse(
            `${current.overrides.length}/${MAX_OVERRIDES} overrides in the policy`,
          ),
        };
      }
    }

    const next: LimitOverride = {
      id,
      label: body.label,
      enabled: body.enabled,
      scope: body.scope,
      targets: body.targets,
      // By tier (design §3b/§3c): a scoped record never holds the priority
      // lever and never pins a cell. Stored to match what runs.
      priority: 0,
      delegationId: delegation.id,
      entries: clampToHardCeilings(body.entries).map((entry) => ({
        limitKey: entry.limitKey,
        ...(entry.modelId ? { modelId: entry.modelId } : {}),
        ...(entry.series ? { series: entry.series } : {}),
        value: entry.value,
        ceiling: false,
      })),
      // Ownership metadata comes from the STORED record, never the body.
      createdBy: existing?.createdBy ?? userMail,
      createdAt: existing?.createdAt ?? now,
      updatedBy: userMail,
      updatedAt: now,
    };
    written = next;
    raises = countRaises(current, next);

    return {
      ...current,
      overrides: existing
        ? current.overrides.map((o) => (o.id === id ? next : o))
        : [...current.overrides, next],
      updatedBy: userMail,
      updatedAt: now,
    };
  };

  try {
    const storage = createLimitsBlobStorage();
    const result = await mutatePolicy(storage, mutate, {
      label: 'limits.scopedUpsert',
    });
    if (result.abort) return result.abort;

    console.log(
      `[limits-admin] action=scoped-upsert delegation=${sanitizeForLog(delegationId)} override=${sanitizeForLog(id)} by=${sanitizeForLog(userMail)} raises=${raises}`,
    );
    // Best-effort audit copy (design §7) — never fails the write.
    await writeHistoryEntry(storage, {
      version: 1,
      action: 'scoped-upsert',
      policy: result.policy,
      delegationId,
      overrideId: id,
      updatedBy: userMail,
      updatedAt: now,
    });
    // This replica served the write; others pick it up within the TTL.
    LimitsService.getInstance().invalidate();
    return successResponse({ override: written, verdicts });
  } catch (error) {
    if (error instanceof LimitsConflictError) return conflictResponse();
    if (isStorageFailure(error)) {
      console.error(
        `[limits-admin] scoped upsert: policy storage failed: ${sanitizeForLog(error)}`,
      );
      return policyUnavailableResponse();
    }
    return handleApiError(error, 'Failed to write scoped override');
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const { id } = await params;
  const authz = await authorize(id);
  if (!authz.ok) return authz.response;
  const user = authz.user;
  const userMail = user.mail!.trim().toLowerCase();

  const now = new Date().toISOString();
  let delegationId = '';
  /** Whether an earlier CAS round saw the record under the caller's delegation. */
  let sawOwned = false;

  const mutate = (
    current: LimitsPolicy | null,
    etag: string | null,
  ): PolicyMutationOutcome => {
    if (!current) return { abort: forbiddenResponse() };
    assertEtag(etag);

    const caller = resolveScopedCaller(user, current);
    if (!caller.isGlobalAdmin && caller.visible.length === 0) {
      return { abort: forbiddenResponse() };
    }

    // A global-tier record (no delegationId), another delegation's record
    // and an id that is not stored at all get ONE answer — a scoped admin
    // must neither delete a global admin's rule by guessing its id nor learn
    // which guessed ids exist. The 404 is reserved for a record this caller
    // owned on an earlier round that a global admin deleted in between.
    const existing = current.overrides.find((o) => o.id === id);
    if (!existing) {
      return {
        abort: sawOwned
          ? notFoundResponse('Override')
          : foreignOverrideResponse(),
      };
    }
    const owning = existing.delegationId
      ? caller.visible.find((d) => d.id === existing.delegationId)
      : undefined;
    if (!owning) return { abort: foreignOverrideResponse() };
    if (!caller.writable.has(owning.id)) {
      return { abort: forbiddenResponse('This delegation is disabled') };
    }
    sawOwned = true;
    delegationId = owning.id;

    return {
      ...current,
      overrides: current.overrides.filter((o) => o.id !== id),
      updatedBy: userMail,
      updatedAt: now,
    };
  };

  try {
    const storage = createLimitsBlobStorage();
    const result = await mutatePolicy(storage, mutate, {
      label: 'limits.scopedDelete',
    });
    if (result.abort) return result.abort;

    console.log(
      `[limits-admin] action=scoped-delete delegation=${sanitizeForLog(delegationId)} override=${sanitizeForLog(id)} by=${sanitizeForLog(userMail)}`,
    );
    await writeHistoryEntry(storage, {
      version: 1,
      action: 'scoped-delete',
      policy: result.policy,
      delegationId,
      overrideId: id,
      updatedBy: userMail,
      updatedAt: now,
    });
    LimitsService.getInstance().invalidate();
    return successResponse({ deleted: true });
  } catch (error) {
    if (error instanceof LimitsConflictError) return conflictResponse();
    if (isStorageFailure(error)) {
      console.error(
        `[limits-admin] scoped delete: policy storage failed: ${sanitizeForLog(error)}`,
      );
      return policyUnavailableResponse();
    }
    return handleApiError(error, 'Failed to delete scoped override');
  }
}

/**
 * `mutatePolicy` propagates read/parse and non-412 write failures unchanged.
 * A storage error (Azure status, network code) or an unparseable stored
 * document (`PolicyUnreadableError` — `readPolicy` wraps BOTH a JSON syntax
 * failure and a read-schema rejection, so this is classified by origin, not
 * by error class) means the policy is unavailable, which the client must
 * render as "unavailable, retry" (design §8) — never as a failure of the
 * admin's own edit, and never as "nothing configured". Anything else,
 * including a mutator result the read schema rejects, is a real 500.
 */
function isStorageFailure(error: unknown): boolean {
  if (error instanceof PolicyUnreadableError) return true;
  if (statusCodeOf(error) !== undefined) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}
