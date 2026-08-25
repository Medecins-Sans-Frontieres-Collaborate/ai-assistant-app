/**
 * POST /api/agent-access/m365-agents/index/cancel  { id, jobId }
 *
 * Marks the job terminal. Chunks already uploaded stay in the index
 * (deterministic ids — the next run reconciles them); the agent's sources
 * drop back to `pending`.
 */
import { NextRequest } from 'next/server';

import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import { auditAdminWrite } from '@/lib/services/agentAccess/adminRouteHelpers';
import { authorizeM365AgentAdmin } from '@/lib/services/agentAccess/m365AgentAdminAuth';
import {
  IndexJobMismatchError,
  cancelIndexJob,
} from '@/lib/services/m365/agentIndexJobService';

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
    jobId: z
      .string()
      .trim()
      .regex(/^job-[a-f0-9]{12}$/),
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
  if (!parsed.success) return badRequestResponse('Invalid cancel body');

  try {
    const authz = await authorizeM365AgentAdmin(parsed.data.id);
    if (!authz.ok) return authz.response;
    const { userMail, canonicalKey } = authz.context;

    let summary;
    try {
      summary = await cancelIndexJob(
        createAgentAccessBlobStorage(),
        parsed.data.id,
        parsed.data.jobId,
      );
    } catch (error) {
      if (error instanceof IndexJobMismatchError) {
        return errorResponse(
          error.message,
          409,
          undefined,
          'M365_INDEX_JOB_MISMATCH',
        );
      }
      throw error;
    }
    if (!summary) return notFoundResponse('Index job');
    auditAdminWrite('m365-agent-index-cancelled', canonicalKey, userMail);
    return successResponse({ job: summary });
  } catch (error) {
    return handleApiError(error, 'Failed to cancel indexing');
  }
}
