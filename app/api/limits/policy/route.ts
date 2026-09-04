import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

/**
 * GET/PUT /api/limits/policy — the org-wide usage-limits policy.
 *
 * GLOBAL admins only (env roster ∪ config roster). Scoped admins
 * (docs/LIMITS_SCOPED_ADMINS_DESIGN.md) never write through here: they get a
 * narrow per-override path (/api/limits/scoped/…) because a full-document PUT
 * from them would carry the global defaults and every other admin's
 * overrides, and a stale draft would revert them.
 *
 * CAS: If-Match update / absent If-Match create-only, 412 → 409. GET reads
 * storage DIRECTLY rather than the ≤60s stale service snapshot, so the echoed
 * ETag is current for editing.
 *
 * The PUT PRE-READS the stored document (design §5) and compares its ETag to
 * `If-Match` before anything else — a mismatch, or no `If-Match` while a
 * document exists, is a 409 up front. Everything that follows is judged
 * against that verified read: `createdBy`/`createdAt` are preserved for
 * override and delegation ids that already exist (ownership metadata never
 * comes from the body); a body with no `delegations` key while the stored
 * policy has some is a stale pre-delegations client and is refused with a
 * 409-shaped "reload" (design §9) — tested on RAW key presence, because zod
 * would erase it; an override may only reference a delegation present in the
 * same body, which is also what blocks deleting a delegation that still owns
 * overrides; `delegationId` overrides are normalized to `priority: 0` and
 * `ceiling: false` so stored data matches what the resolver runs; and the
 * budget `globalOverrides + Σ maxOverrides ≤ 200` keeps scoped admins from
 * ever hitting a document-full error only a global admin could fix. The
 * client's `If-Match` still reaches `writePolicy`, so the blob CAS remains the
 * final arbiter.
 */
// Only an exact quoted strong ETag may reach a storage CAS condition — see
// STRONG_ETAG_REGEX in adminRouteHelpers for the full rationale.
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import {
  LimitsConflictError,
  createLimitsBlobStorage,
  readPolicy,
  writeHistoryEntry,
  writePolicy,
} from '@/lib/services/limits/limitsStore';
import {
  MAX_OVERRIDES,
  WriteDelegation,
  clampToHardCeilings,
  formatIssues,
  isValidTimezone,
  putBodySchema,
} from '@/lib/services/limits/policyWriteSchema';
import {
  LimitDelegation,
  LimitOverride,
  LimitsPolicy,
} from '@/lib/services/limits/types';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { randomBytes } from 'node:crypto';

function conflictResponse(details?: string) {
  return errorResponse(
    'Limits policy was modified by another admin; reload and retry',
    409,
    details,
    'LIMITS_CONFLICT',
  );
}

/** Server-generated, immutable; matches DELEGATION_ID_RE. */
function newDelegationId(): string {
  return `del-${randomBytes(6).toString('hex')}`;
}

function canonicalList(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()))].filter(
    Boolean,
  );
}

/**
 * Canonicalizes exactly like the matchers do (`trim().toLowerCase()`, see
 * principalMatching.ts and adminAuth.ts) — a different normalizer here would
 * create a second definition of "matches". Group ids and attribute values
 * are lowercased too, which is how `intersectsTargets` compares them.
 */
function normalizeDelegation(
  input: WriteDelegation,
  id: string,
  stored: LimitDelegation | undefined,
  userMail: string,
  now: string,
): LimitDelegation {
  return {
    id,
    label: input.label,
    enabled: input.enabled,
    admins: canonicalList(input.admins),
    jurisdiction: input.jurisdiction.map((predicate) => ({
      scope: predicate.scope,
      targets: canonicalList(predicate.targets),
    })),
    maxOverrides: input.maxOverrides,
    createdBy: stored?.createdBy ?? userMail,
    createdAt: stored?.createdAt ?? now,
    updatedBy: userMail,
    updatedAt: now,
  };
}

export async function GET() {
  // No feature gate here: the `usageLimits` LaunchDarkly flag is CLIENT-side
  // only (it hides the admin UI), so the server cannot evaluate it. The
  // global-admin check below is, and always was, the real access control.
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    const result = await readPolicy(createLimitsBlobStorage());
    return successResponse({
      policy: result?.policy ?? null,
      etag: result?.etag ?? null,
      policyUnavailable: false,
    });
  } catch (error) {
    // ⚠ Never answer "no policy configured" on a read failure: that would
    // tell an admin everything is unlimited while enforcement does something
    // else entirely. The client renders an error + Retry, never an empty form.
    console.error(
      `[limits-admin] policy read failed: ${sanitizeForLog(error)}`,
    );
    return successResponse({
      policy: null,
      etag: null,
      policyUnavailable: true,
    });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail || !isGlobalAdmin(session.user)) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  // Raw presence, not the parsed value: `.optional()` on the schema keeps
  // "omitted" distinguishable from "[]", but only if we look before zod does.
  const hasDelegationsKey =
    typeof body === 'object' &&
    body !== null &&
    Object.hasOwn(body, 'delegations');

  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid limits policy',
      formatIssues(parsed.error),
    );
  }
  if (!isValidTimezone(parsed.data.timezone)) {
    return badRequestResponse('Unknown timezone');
  }
  const duplicateId = parsed.data.overrides
    .map((o) => o.id)
    .find((id, index, all) => all.indexOf(id) !== index);
  if (duplicateId) {
    return badRequestResponse('Duplicate override id', duplicateId);
  }

  const bodyDelegations = parsed.data.delegations ?? [];
  const duplicateDelegationId = bodyDelegations
    .map((d) => d.id)
    .filter((id): id is string => id !== undefined)
    .find((id, index, all) => all.indexOf(id) !== index);
  if (duplicateDelegationId) {
    return badRequestResponse('Duplicate delegation id', duplicateDelegationId);
  }

  // Budget (design §5): scoped admins must never be refused with a
  // document-full error only a global admin can fix.
  const globalOverrideCount = parsed.data.overrides.filter(
    (o) => !o.delegationId,
  ).length;
  const delegatedBudget = bodyDelegations.reduce(
    (sum, d) => sum + d.maxOverrides,
    0,
  );
  if (globalOverrideCount + delegatedBudget > MAX_OVERRIDES) {
    return errorResponse(
      'Delegation budgets plus global overrides exceed the document cap',
      400,
      `${globalOverrideCount} global override(s) + ${delegatedBudget} delegated > ${MAX_OVERRIDES}`,
      'LIMITS_BUDGET_EXCEEDED',
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  try {
    const storage = createLimitsBlobStorage();
    // Pre-read (design §5). A read failure is a 500 here, never a blind
    // write: preservation and the guards below only mean something against
    // the document the client actually edited.
    const stored = await readPolicy(storage);

    // ETag compare FIRST. `downloadBlob` can fall back to '' when the SDK
    // omits the ETag; a client can never send that, so only a real ETag is
    // compared — the blob CAS below still decides in that corner.
    const storedEtag = stored?.etag ? stored.etag : null;
    if (stored && ifMatchEtag === null) return conflictResponse();
    if (!stored && ifMatchEtag !== null) return conflictResponse();
    if (storedEtag !== null && storedEtag !== ifMatchEtag) {
      return conflictResponse();
    }

    // Stale-client guard (design §9): a pre-delegations client would erase
    // every delegation and orphan every scoped override.
    if (!hasDelegationsKey && (stored?.policy.delegations.length ?? 0) > 0) {
      return conflictResponse('reload');
    }

    const storedOverrides = new Map(
      (stored?.policy.overrides ?? []).map((o) => [o.id, o]),
    );
    const storedDelegations = new Map(
      (stored?.policy.delegations ?? []).map((d) => [d.id, d]),
    );
    const now = new Date().toISOString();

    const delegations: LimitDelegation[] = bodyDelegations.map((d) => {
      const id = d.id ?? newDelegationId();
      return normalizeDelegation(
        d,
        id,
        storedDelegations.get(id),
        userMail,
        now,
      );
    });
    const delegationIds = new Set(delegations.map((d) => d.id));

    // Every delegationId must resolve inside THIS body. Dropping a
    // delegation while keeping its overrides is exactly the "delete a
    // delegation that still owns overrides" case (design §6a): refused with
    // the count, so the client can offer disable / delete-with-overrides.
    for (const delegation of storedDelegations.values()) {
      if (delegationIds.has(delegation.id)) continue;
      const owned = parsed.data.overrides.filter(
        (o) => o.delegationId === delegation.id,
      ).length;
      if (owned > 0) {
        return badRequestResponse(
          'Delegation still owns overrides; disable it or delete them too',
          `${delegation.id}: ${owned} override(s)`,
        );
      }
    }
    const orphan = parsed.data.overrides.find(
      (o) => o.delegationId && !delegationIds.has(o.delegationId),
    );
    if (orphan) {
      return badRequestResponse(
        'Override references a delegation that is not in this policy',
        orphan.id,
      );
    }

    const overrides: LimitOverride[] = parsed.data.overrides.map((override) => {
      const existing = storedOverrides.get(override.id);
      const scoped = override.delegationId !== undefined;
      return {
        ...override,
        // Design §3b/§3c by tier: a scoped record never holds the priority
        // lever and never pins a cell — normalize so storage matches what
        // the resolver would do anyway.
        priority: scoped ? 0 : override.priority,
        entries: clampToHardCeilings(override.entries).map((entry) =>
          scoped ? { ...entry, ceiling: false } : entry,
        ),
        // Ownership metadata is preserved from the STORED record, never
        // taken from the body (ADMIN_LIMITS_REVIEW #18).
        createdBy: existing?.createdBy ?? userMail,
        createdAt: existing?.createdAt ?? now,
        updatedBy: userMail,
        updatedAt: now,
      };
    });

    const policy: LimitsPolicy = {
      version: 1,
      defaults: clampToHardCeilings(parsed.data.defaults),
      overrides,
      delegations,
      mode: parsed.data.mode,
      failMode: parsed.data.failMode,
      timezone: parsed.data.timezone,
      countByomUsage: parsed.data.countByomUsage,
      countAuxiliaryUsage: parsed.data.countAuxiliaryUsage,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writePolicy(storage, policy, ifMatchEtag);
    console.log(
      `[limits-admin] action=upsert mode=${policy.mode} overrides=${policy.overrides.length} delegations=${policy.delegations.length} by=${sanitizeForLog(userMail)}`,
    );
    // Best-effort audit copy — never fails the write the admin just made.
    await writeHistoryEntry(storage, {
      version: 1,
      action: 'upsert',
      policy,
      updatedBy: userMail,
      updatedAt: now,
    });
    // This replica served the write, so drop its cache immediately; others
    // pick the change up within the 60s TTL.
    LimitsService.getInstance().invalidate();
    return successResponse({ policy, etag });
  } catch (error) {
    if (error instanceof LimitsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to write limits policy');
  }
}
