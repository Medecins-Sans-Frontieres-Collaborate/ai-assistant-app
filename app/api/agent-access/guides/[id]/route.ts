import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  readGuide,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import { hydrateGuide } from '@/lib/services/agentAccess/guidePayloadStore';
import {
  GUIDE_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const GUIDE_ID_PATTERN = /^guide-[a-f0-9]{12}$/;

/**
 * GET /api/agent-access/guides/[id] — one guide WITH its payload, for the
 * admin editor. The listing serves META only (the payload lives in an
 * external blob outside the access snapshot), so opening a guide for
 * editing loads its body/entries here. Reads storage directly so the echoed
 * etag is CAS-fresh for the editor's If-Match.
 *
 * `payloadMissing` is reported rather than 404'd: the meta exists and the
 * admin's remedy is to re-save it, which writes a fresh payload.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const { id } = await params;
  if (!GUIDE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid guide id');
  }
  const canonicalKey = canonicalAgentKey(GUIDE_SOURCE, id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this guide key');
    }

    const storage = createAgentAccessBlobStorage();
    const existing = await readGuide(storage, id);
    if (existing === null) return notFoundResponse('Guide');

    const hydrated = await hydrateGuide(existing.guide, storage);
    return successResponse({
      guide: hydrated ?? existing.guide,
      etag: existing.etag,
      canonicalKey,
      payloadMissing: hydrated === null,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to load guide');
  }
}
