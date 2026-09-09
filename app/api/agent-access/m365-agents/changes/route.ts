/**
 * GET /api/agent-access/m365-agents/changes?id=<agentId>
 *
 * Change detection for the editor banner (seventh pass §7): follows each
 * source's stored delta link (or re-lists) with the CALLING ADMIN'S token
 * and reports what a refresh would add / update / remove — metadata only,
 * nothing indexed, nothing written. `null` when the agent has no manifest
 * yet (never indexed under the planner): there is nothing to diff against.
 */
import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readM365Agent,
  readM365AgentManifest,
} from '@/lib/services/agentAccess/accessRulesStore';
import { authorizeM365AgentAdmin } from '@/lib/services/agentAccess/m365AgentAdminAuth';
import { readDerivedIndex } from '@/lib/services/m365/agentDerivedTextStore';
import { previewRefresh } from '@/lib/services/m365/agentIndexService';
import { M365Error, m365ErrorResponse } from '@/lib/services/m365/graphApi';

import {
  handleApiError,
  notFoundResponse,
  successResponse,
} from '@/lib/utils/server/api/apiResponse';

export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get('id')?.trim() ?? '';
  try {
    const authz = await authorizeM365AgentAdmin(id);
    if (!authz.ok) return authz.response;

    const storage = createAgentAccessBlobStorage();
    const [existing, manifest, derived] = await Promise.all([
      readM365Agent(storage, id),
      readM365AgentManifest(storage, id),
      readDerivedIndex(storage, id),
    ]);
    if (!existing) return notFoundResponse('M365 agent');
    if (!manifest) {
      return successResponse({ preview: null, lastIndexedAt: null });
    }
    try {
      const preview = await previewRefresh(
        request,
        existing.m365Agent,
        authz.context.userId,
        manifest,
        derived.index.items,
      );
      return successResponse({ preview, lastIndexedAt: manifest.updatedAt });
    } catch (error) {
      if (error instanceof M365Error) return m365ErrorResponse(error);
      throw error;
    }
  } catch (error) {
    return handleApiError(error, 'Failed to check for changes');
  }
}
