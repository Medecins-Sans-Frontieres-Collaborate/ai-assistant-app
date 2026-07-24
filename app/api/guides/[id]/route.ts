import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { GUIDE_SOURCE, guidePayload } from '@/lib/services/agentAccess/types';

import {
  badRequestResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const GUIDE_ID_PATTERN = /^guide-[a-f0-9]{12}$/;

/**
 * GET /api/guides/[id] — one guide INCLUDING its body, for the read-only
 * viewer (users may read the criteria they are being reviewed against).
 *
 * A guide the user may not see answers the SAME 404 as one that does not
 * exist — anything else is an existence oracle for restricted guides.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Guide');

  const { id } = await params;
  if (!GUIDE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid guide id');
  }

  try {
    await service.ensureFresh();
    const guide = service.getGuideById(id);
    if (guide === null) return notFoundResponse('Guide');

    const decision = service.evaluateAccess({
      userMail: session.user.mail ?? undefined,
      source: GUIDE_SOURCE,
      agentName: guide.id,
    });
    // Fail closed on 'unavailable' too — same contract as the listing.
    if (decision.decision !== 'allow') return notFoundResponse('Guide');

    // An incoherent record (legacy body-only structured guide) answers the
    // same 404 as missing/denied: it cannot be invoked, so exposing it to
    // the viewer would only advertise something assess will reject.
    const payload = guidePayload(guide);
    if (payload === null) return notFoundResponse('Guide');
    const { kind: _payloadKind, ...payloadFields } = payload;

    return successResponse({
      guide: {
        id: guide.id,
        kind: guide.kind,
        name: guide.name,
        description: guide.description,
        languages: guide.languages,
        workflows: guide.workflows,
        ...payloadFields,
        updatedAt: guide.updatedAt,
      },
    });
  } catch (error) {
    return handleApiError(error, 'Failed to load guide');
  }
}
