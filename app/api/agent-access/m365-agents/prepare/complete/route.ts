/**
 * POST /api/agent-access/m365-agents/prepare/complete  { id, itemId }
 *
 * Finishes a pending chunked transcription for a prepared file: reads the
 * job from the CALLING ADMIN'S user container (it must be the admin who
 * started it) and stores the transcript as derived text.
 */
import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readM365Agent,
} from '@/lib/services/agentAccess/accessRulesStore';
import { authorizeM365AgentAdmin } from '@/lib/services/agentAccess/m365AgentAdminAuth';
import {
  PreparationError,
  completePendingPreparation,
} from '@/lib/services/m365/agentPreparationService';
import { GRAPH_ID_REGEX } from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

import { z } from 'zod';

const bodySchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    itemId: z.string().trim().min(1).max(512).regex(GRAPH_ID_REGEX),
  })
  .strict();

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return badRequestResponse('Invalid complete body');

  try {
    const authz = await authorizeM365AgentAdmin(parsed.data.id);
    if (!authz.ok) return authz.response;

    const storage = createAgentAccessBlobStorage();
    const existing = await readM365Agent(storage, parsed.data.id);
    if (!existing) return notFoundResponse('M365 agent');

    try {
      const outcome = await completePendingPreparation(
        authz.context.session,
        storage,
        existing.m365Agent,
        parsed.data.itemId,
      );
      return successResponse({ outcome });
    } catch (error) {
      if (error instanceof PreparationError) {
        return errorResponse(
          error.message,
          error.status,
          undefined,
          'M365_PREPARE_REFUSED',
        );
      }
      throw error;
    }
  } catch (error) {
    return handleApiError(error, 'Failed to complete preparation');
  }
}
