/**
 * POST /api/agent-access/m365-agents/index  { id }
 *
 * STARTS a resumable index job for an M365 agent (seventh pass §4): plans
 * every source with the CALLING ADMIN'S delegated Graph token — the
 * constraint the whole design honors: refresh tokens exist only inside
 * the session JWT, so indexing runs only while someone with file access
 * is present — and writes the job with every indexable item pending.
 * The caller then drives ./step until the job is terminal.
 *
 * 409 with the running job's summary when one is already active.
 */
import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readM365Agent,
} from '@/lib/services/agentAccess/accessRulesStore';
import { auditAdminWrite } from '@/lib/services/agentAccess/adminRouteHelpers';
import { AgentAccessConflictError } from '@/lib/services/agentAccess/blobCas';
import { authorizeM365AgentAdmin } from '@/lib/services/agentAccess/m365AgentAdminAuth';
import {
  IndexJobActiveError,
  startIndexJob,
} from '@/lib/services/m365/agentIndexJobService';
import { M365Error, m365ErrorResponse } from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

export const maxDuration = 120;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const id =
    typeof body === 'object' && body !== null && 'id' in body
      ? String((body as { id: unknown }).id).trim()
      : '';

  try {
    const authz = await authorizeM365AgentAdmin(id);
    if (!authz.ok) return authz.response;
    const { userId, userMail, canonicalKey } = authz.context;

    const storage = createAgentAccessBlobStorage();
    const existing = await readM365Agent(storage, id);
    if (!existing) return notFoundResponse('M365 agent');

    let summary;
    try {
      summary = await startIndexJob(
        request,
        storage,
        existing.m365Agent,
        userId,
        userMail,
      );
    } catch (error) {
      if (error instanceof IndexJobActiveError) {
        // The client reads ./status for the running job's summary.
        return errorResponse(
          error.message,
          409,
          `job ${error.summary.jobId} started by ${error.summary.startedBy}`,
          'M365_INDEX_JOB_ACTIVE',
        );
      }
      if (error instanceof AgentAccessConflictError) {
        return errorResponse(
          'Another admin started indexing at the same time; reload',
          409,
          undefined,
          'AGENT_ACCESS_CONFLICT',
        );
      }
      if (error instanceof M365Error) return m365ErrorResponse(error);
      throw error;
    }
    auditAdminWrite('m365-agent-index-start', canonicalKey, userMail);
    return successResponse({ job: summary });
  } catch (error) {
    return handleApiError(error, 'Failed to start indexing');
  }
}
