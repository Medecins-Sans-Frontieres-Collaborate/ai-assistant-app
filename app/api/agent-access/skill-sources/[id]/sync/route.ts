import { NextRequest } from 'next/server';

import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import { auditAdminWrite } from '@/lib/services/agentAccess/adminRouteHelpers';
import { requireSkillSourceAdmin } from '@/lib/services/skills/skillSourceAuth';
import { syncSkillSource } from '@/lib/services/skills/skillSourceSync';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

export const maxDuration = 120;

/** Forces a refresh of one source now (`?force=true` re-imports unchanged versions). */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gate = await requireSkillSourceAdmin();
  if (gate instanceof Response) return gate;
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id))
    return badRequestResponse('id is not a valid source id');
  try {
    const result = await syncSkillSource(createAgentAccessBlobStorage(), id, {
      actor: gate.userMail,
      force: request.nextUrl.searchParams.get('force') === 'true',
      signal: request.signal,
    });
    if (!result.source) return notFoundResponse('Skill source');
    if (result.busy)
      return errorResponse(
        'A sync of this source is already running',
        409,
        undefined,
        'SKILL_SOURCE_BUSY',
      );
    auditAdminWrite('skill-source-sync', `skill-source::${id}`, gate.userMail);
    return successResponse({ source: result.source });
  } catch (error) {
    return handleApiError(error, 'Failed to sync skill source');
  }
}
