import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  listHistoryEntries,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';

import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/agent-access/history?key=<canonicalKey> — the immutable audit
 * trail for one canonical key, newest first. Entity-agnostic: every write
 * across rules and the admin entities already appends a full-record history
 * blob; this endpoint finally makes them readable. The client uses the
 * embedded record payload for the review-then-save restore flow (restore is
 * a NORMAL entity PUT — re-validated, CAS-guarded, and itself audited — so
 * there is deliberately no separate restore endpoint to bypass those).
 *
 * Authorization mirrors the entity routes: 404 while the feature is
 * disabled; admins only; local admins only for keys they can edit.
 */

/** ≤50 entries per response — the audit trail can grow unbounded. */
const MAX_HISTORY_ENTRIES = 50;

export async function GET(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const key = request.nextUrl.searchParams.get('key')?.trim() ?? '';
  // Canonical keys are `<source>::<id>` where source may be an ARM path;
  // require the shape and a sane length, nothing stricter (the key is
  // hashed before it ever reaches a blob path).
  if (!key || key.length > 600 || !key.includes('::')) {
    return badRequestResponse('key must be a canonical agent key');
  }

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, key)) {
      return forbiddenResponse('Not authorized for this agent key');
    }

    const entries = await listHistoryEntries(
      createAgentAccessBlobStorage(),
      key,
    );
    return successResponse({
      canonicalKey: key,
      entries: entries.slice(0, MAX_HISTORY_ENTRIES).map((e) => e.entry),
      truncated: entries.length > MAX_HISTORY_ENTRIES,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list history');
  }
}
