/**
 * POST /api/agent-access/m365-agents/prepare  { id, driveId, itemId }
 *
 * Prepares ONE file (image → vision description, scanned PDF → OCR,
 * audio/video → transcription) with the CALLING ADMIN'S Graph token and
 * caches the text for the agent (phase 4). Never batched: this is the
 * per-file "Prepare" button. Large media returns `pending` with a chunked
 * transcription job id the browser polls; ./complete stores the result.
 */
import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readM365Agent,
} from '@/lib/services/agentAccess/accessRulesStore';
import { auditAdminWrite } from '@/lib/services/agentAccess/adminRouteHelpers';
import { authorizeM365AgentAdmin } from '@/lib/services/agentAccess/m365AgentAdminAuth';
import {
  PreparationError,
  prepareAgentItem,
} from '@/lib/services/m365/agentPreparationService';
import {
  GRAPH_ID_REGEX,
  M365Error,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { z } from 'zod';

export const maxDuration = 300;

const bodySchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    driveId: z.string().trim().min(1).max(512).regex(GRAPH_ID_REGEX),
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
  if (!parsed.success) return badRequestResponse('Invalid prepare body');

  try {
    const authz = await authorizeM365AgentAdmin(parsed.data.id);
    if (!authz.ok) return authz.response;
    const session = await auth();
    if (!session?.user) return notFoundResponse('Session');

    const storage = createAgentAccessBlobStorage();
    const existing = await readM365Agent(storage, parsed.data.id);
    if (!existing) return notFoundResponse('M365 agent');

    let outcome;
    try {
      outcome = await prepareAgentItem(
        request,
        session,
        storage,
        existing.m365Agent,
        {
          driveId: parsed.data.driveId,
          itemId: parsed.data.itemId,
        },
      );
    } catch (error) {
      if (error instanceof PreparationError) {
        return errorResponse(
          error.message,
          error.status,
          undefined,
          'M365_PREPARE_REFUSED',
        );
      }
      if (error instanceof M365Error) return m365ErrorResponse(error);
      throw error;
    }
    auditAdminWrite(
      `m365-agent-prepare-${outcome.status}`,
      authz.context.canonicalKey,
      authz.context.userMail,
    );
    return successResponse({ outcome });
  } catch (error) {
    return handleApiError(error, 'Failed to prepare file');
  }
}
