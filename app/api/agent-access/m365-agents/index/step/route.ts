/**
 * POST /api/agent-access/m365-agents/index/step  { id, jobId }
 *
 * Runs one time-boxed slice of the agent's index job with the CALLING
 * ADMIN'S Graph token and returns progress; the browser loops until the
 * job is terminal. Any admin holding the key may step — that is how an
 * interrupted job is resumed by whoever is around.
 */
import { NextRequest } from 'next/server';

import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import { auditAdminWrite } from '@/lib/services/agentAccess/adminRouteHelpers';
import { authorizeM365AgentAdmin } from '@/lib/services/agentAccess/m365AgentAdminAuth';
import {
  IndexJobMismatchError,
  stepIndexJob,
} from '@/lib/services/m365/agentIndexJobService';
import { M365Error, m365ErrorResponse } from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

import { z } from 'zod';

export const maxDuration = 120;

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
  if (!parsed.success) return badRequestResponse('Invalid step body');

  try {
    const authz = await authorizeM365AgentAdmin(parsed.data.id);
    if (!authz.ok) return authz.response;
    const { userMail, canonicalKey } = authz.context;

    let summary;
    try {
      summary = await stepIndexJob(
        request,
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
      if (error instanceof M365Error) return m365ErrorResponse(error);
      throw error;
    }
    if (summary.status !== 'running') {
      auditAdminWrite(
        `m365-agent-index-${summary.status}`,
        canonicalKey,
        userMail,
      );
    }
    return successResponse({ job: summary });
  } catch (error) {
    return handleApiError(error, 'Failed to step indexing');
  }
}
