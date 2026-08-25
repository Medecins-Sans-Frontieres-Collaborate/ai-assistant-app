/**
 * Shared authorization for the M365 agent index routes (start / step /
 * cancel / status): session → admin status → holds the agent's canonical
 * key. Mirrors the checks PUT performs in the CRUD route so a job can only
 * be driven by someone who could edit the agent.
 */
import { NextResponse } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  M365_AGENT_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import {
  badRequestResponse,
  forbiddenResponse,
  notFoundResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export const M365_AGENT_ID_PATTERN = /^m365-[a-f0-9]{12}$/;

export interface M365AgentAdminContext {
  userId: string;
  userMail: string;
  canonicalKey: string;
}

export type M365AgentAdminResult =
  | { ok: true; context: M365AgentAdminContext }
  | { ok: false; response: NextResponse };

export async function authorizeM365AgentAdmin(
  id: string,
): Promise<M365AgentAdminResult> {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) {
    return { ok: false, response: notFoundResponse('Resource') };
  }
  const session = await auth();
  if (!session?.user) return { ok: false, response: unauthorizedResponse() };
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return { ok: false, response: forbiddenResponse() };
  if (!M365_AGENT_ID_PATTERN.test(id)) {
    return { ok: false, response: badRequestResponse('Invalid agent id') };
  }

  const canonicalKey = canonicalAgentKey(M365_AGENT_SOURCE, id);
  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    return { ok: false, response: forbiddenResponse() };
  }
  if (!canEditKey(status, canonicalKey)) {
    return {
      ok: false,
      response: forbiddenResponse('Not authorized for this agent key'),
    };
  }
  return {
    ok: true,
    context: { userId: session.user.id, userMail, canonicalKey },
  };
}
