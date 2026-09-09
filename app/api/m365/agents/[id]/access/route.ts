/**
 * M365 agent access preflight (layer 2, advisory copy of the server trim).
 *
 * GET /api/m365/agents/[id]/access — per-source accessibility for the
 * CALLER, computed with the caller's own delegated Graph token. Drives the
 * chat-side banner states (all/partial/none accessible, or "connect
 * first"). Enforcement does NOT live here — the chat pipeline re-probes
 * server-side on every invocation — so this endpoint can afford to be
 * purely informational.
 *
 * Layer 1 is checked first: users the access rules deny get the same 404 an
 * unknown id gets, so the endpoint never confirms a restricted agent exists.
 */
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { M365_AGENT_SOURCE } from '@/lib/services/agentAccess/types';
import { checkAgentSourceAccess } from '@/lib/services/m365/agentSourceAccess';
import { M365Error } from '@/lib/services/m365/graphApi';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import {
  errorResponse,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const M365_AGENT_ID_PATTERN = /^m365-[a-f0-9]{12}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user?.id) return unauthorizedResponse();

  // Group-membership warm-up MUST precede the layer-1 evaluateAccess check
  // below — group-scoped rules read the cache synchronously. Never throws.
  await resolveUserGroupIds(request, session);

  const { id } = await params;
  if (!M365_AGENT_ID_PATTERN.test(id)) return notFoundResponse('Agent');

  await service.ensureFresh();
  const agent = service.getM365AgentById(id);
  if (!agent) return notFoundResponse('Agent');

  // Layer 1 — deny reads as not-found; unavailable fails closed.
  const decision = service.evaluateAccess({
    userMail: session.user.mail,
    source: M365_AGENT_SOURCE,
    agentName: agent.id,
  });
  if (decision.decision === 'deny') return notFoundResponse('Agent');
  if (decision.decision === 'unavailable') {
    return errorResponse('Agent access is temporarily unavailable', 503);
  }

  // Layer 2 — per-source probes with the caller's token. A missing Graph
  // session/consent is the "connect first" state, not an error.
  try {
    const access = await checkAgentSourceAccess(
      request,
      session.user.id,
      agent,
    );
    const accessibleById = new Map(
      access.results.map((r) => [r.sourceId, r.accessible]),
    );
    return successResponse({
      connected: true,
      agentName: agent.name,
      sources: agent.sources.map((source) => {
        const accessible = accessibleById.get(source.sourceId) ?? false;
        return {
          sourceId: source.sourceId,
          title: source.title,
          accessible,
          // The request-access link + owner hint only matter when denied.
          ...(!accessible && source.webUrl && { webUrl: source.webUrl }),
          ...(!accessible &&
            source.ownerDisplay && { ownerDisplay: source.ownerDisplay }),
        };
      }),
    });
  } catch (error) {
    if (
      error instanceof M365Error &&
      (error.kind === 'not_connected' || error.kind === 'consent_missing')
    ) {
      return successResponse({ connected: false, sources: [] });
    }
    return errorResponse('Could not check source access', 502);
  }
}
