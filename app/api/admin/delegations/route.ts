import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { DelegationsService } from '@/lib/services/delegations/DelegationsService';
import {
  DelegationsConflictError,
  createDelegationsBlobStorage,
  writeDelegationsDocument,
  writeDelegationsHistory,
} from '@/lib/services/delegations/delegationsStore';
import {
  DelegationsDocument,
  SharedDelegation,
} from '@/lib/services/delegations/types';
import { delegationsPutBodySchema } from '@/lib/services/delegations/writeSchema';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import {
  loadDelegationsDocument,
  readPolicy,
} from '@/lib/services/limits/limitsStore';
import { MAX_OVERRIDES } from '@/lib/services/limits/policyWriteSchema';

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
import { randomBytes } from 'crypto';

/**
 * GET/PUT /api/admin/delegations — the shared delegations document
 * (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §7).
 *
 * GLOBAL admins only: a delegation decides who else may administer, so it is
 * never something a delegate edits. The check takes the session USER, so an
 * admin "viewing as" a lesser role is refused exactly as that role would be.
 *
 * CAS: If-Match required for an update. GET reads storage directly (running
 * the one-time migration out of the limits policy if it has not happened
 * yet), so the echoed ETag is current for editing.
 *
 * Cross-document guards — the limits policy references delegations by id:
 *  - a delegation that still owns limit overrides cannot be deleted, nor lose
 *    its `limits` capability (the overrides would silently go inert);
 *  - delegated override budgets plus global overrides must still fit the
 *    policy's document cap, so a scoped admin is never refused with a
 *    "document full" error only a global admin can fix.
 */

function newDelegationId(): string {
  return `del-${randomBytes(6).toString('hex')}`;
}

function conflictResponse() {
  return errorResponse(
    'Delegations were modified by another admin; reload and retry',
    409,
    undefined,
    'DELEGATIONS_CONFLICT',
  );
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    const result = await loadDelegationsDocument(
      createDelegationsBlobStorage(),
    );
    return successResponse({
      document: result.document,
      etag: result.etag,
      unavailable: false,
    });
  } catch (error) {
    // Never answer "no delegations" on a read failure: the admin would
    // rebuild from an empty list and overwrite the real one.
    console.error(`[delegations-admin] read failed: ${sanitizeForLog(error)}`);
    return successResponse({ document: null, etag: null, unavailable: true });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = delegationsPutBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid delegations',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const duplicateId = parsed.data.delegations
    .map((d) => d.id)
    .filter((id): id is string => id !== undefined)
    .find((id, index, all) => all.indexOf(id) !== index);
  if (duplicateId) {
    return badRequestResponse('Duplicate delegation id', duplicateId);
  }
  for (const delegation of parsed.data.delegations) {
    const duplicateAdmin = delegation.admins
      .map((a) => a.mail)
      .find((mail, index, all) => all.indexOf(mail) !== index);
    if (duplicateAdmin) {
      return badRequestResponse(
        'An admin is listed twice in one delegation',
        duplicateAdmin,
      );
    }
  }

  try {
    const storage = createDelegationsBlobStorage();
    const stored = await loadDelegationsDocument(storage);
    if (stored.etag && stored.etag !== ifMatchEtag) return conflictResponse();

    const storedById = new Map(
      stored.document.delegations.map((d) => [d.id, d]),
    );
    const now = new Date().toISOString();
    const delegations: SharedDelegation[] = parsed.data.delegations.map(
      (input) => {
        const id = input.id ?? newDelegationId();
        const existing = storedById.get(id);
        return {
          id,
          label: input.label,
          enabled: input.enabled,
          jurisdiction: input.jurisdiction,
          capabilities: input.capabilities,
          admins: input.admins,
          limits: input.limits,
          createdBy: existing?.createdBy ?? userMail,
          createdAt: existing?.createdAt ?? now,
          updatedBy: userMail,
          updatedAt: now,
        };
      },
    );

    // Cross-document guards against the limits policy.
    const policy = (await readPolicy(storage))?.policy ?? null;
    if (policy) {
      const stillOffersLimits = new Set(
        delegations
          .filter((d) => d.capabilities.includes('limits'))
          .map((d) => d.id),
      );
      const ownedCounts = new Map<string, number>();
      for (const override of policy.overrides) {
        if (!override.delegationId) continue;
        ownedCounts.set(
          override.delegationId,
          (ownedCounts.get(override.delegationId) ?? 0) + 1,
        );
      }
      for (const [delegationId, owned] of ownedCounts) {
        if (
          storedById.has(delegationId) &&
          !stillOffersLimits.has(delegationId)
        ) {
          return errorResponse(
            'Delegation still owns limit overrides; disable it, or delete those overrides first',
            400,
            `${delegationId}: ${owned} override(s)`,
            'DELEGATION_OWNS_OVERRIDES',
          );
        }
      }
      const globalOverrides = policy.overrides.filter(
        (o) => !o.delegationId,
      ).length;
      const delegatedBudget = delegations
        .filter((d) => d.capabilities.includes('limits'))
        .reduce((sum, d) => sum + d.limits.maxOverrides, 0);
      if (globalOverrides + delegatedBudget > MAX_OVERRIDES) {
        return errorResponse(
          'Delegated override budgets plus global overrides exceed the limits policy cap',
          400,
          `${globalOverrides} global override(s) + ${delegatedBudget} delegated > ${MAX_OVERRIDES}`,
          'DELEGATION_BUDGET_EXCEEDED',
        );
      }
    }

    const document: DelegationsDocument = {
      ...stored.document,
      version: 1,
      delegations,
      updatedBy: userMail,
      updatedAt: now,
    };
    const etag = await writeDelegationsDocument(storage, document, ifMatchEtag);
    console.log(
      `[delegations-admin] action=upsert delegations=${delegations.length} by=${sanitizeForLog(userMail)}`,
    );
    await writeDelegationsHistory(storage, {
      version: 1,
      document,
      updatedBy: userMail,
      updatedAt: now,
    });
    // This replica served the write; others converge within their 60 s TTLs.
    DelegationsService.getInstance().invalidate();
    LimitsService.getInstance().invalidate();
    return successResponse({ document, etag });
  } catch (error) {
    if (error instanceof DelegationsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to write delegations');
  }
}
