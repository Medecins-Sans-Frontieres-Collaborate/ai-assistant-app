import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  readOrgAgent,
  writeOrgAgent,
  writeOrgAgentHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import {
  auditAdminWrite,
  canEditKey,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  ORG_AGENT_SOURCE,
  OrgRagAgent,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import {
  clearIndexServeableCache,
  validateOrgAgentIndex,
} from '@/lib/services/orgAgents/orgAgentSearchValidation';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { getOrganizationAgents } from '@/lib/organizationAgents';
import { z } from 'zod';

/**
 * POST /api/agent-access/org-agents/validate — re-run the Azure AI Search
 * validation for one record WITHOUT editing it (e.g. after the indexer
 * finished filling a staged index, or to confirm a fixed one). Persists the
 * fresh outcome onto the record under CAS and clears the serve-time recheck
 * cache so a recovered agent starts serving immediately. Gated exactly like
 * the CRUD PUT.
 */

const bodySchema = z.object({ id: z.string().trim().min(1).max(100) });

const ORG_AGENT_ID_PATTERN = /^orgr-[a-f0-9]{12}$/;

function isKnownOrgAgentId(id: string): boolean {
  return (
    ORG_AGENT_ID_PATTERN.test(id) ||
    getOrganizationAgents().some((agent) => agent.id === id)
  );
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success || !isKnownOrgAgentId(parsed.data.id)) {
    return badRequestResponse('Invalid agent id');
  }

  const canonicalKey = canonicalAgentKey(ORG_AGENT_SOURCE, parsed.data.id);
  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this agent key');
    }

    const storage = createAgentAccessBlobStorage();
    const existing = await readOrgAgent(storage, parsed.data.id);
    if (!existing) return notFoundResponse('Org agent');

    const validation = await validateOrgAgentIndex(
      existing.orgAgent.searchIndex,
      existing.orgAgent.semanticConfig,
    );
    const now = new Date().toISOString();
    const agent: OrgRagAgent = {
      ...existing.orgAgent,
      validation,
      updatedBy: userMail,
      updatedAt: now,
    };

    // CAS against the etag we just read: a concurrent edit wins and the
    // admin simply revalidates again from the fresh record.
    const etag = await writeOrgAgent(storage, agent, existing.etag);
    service.invalidate();
    clearIndexServeableCache();
    auditAdminWrite('org-agent-revalidate', canonicalKey, userMail);

    try {
      await writeOrgAgentHistoryEntry(createAgentAccessBlobStorage(), {
        version: 1,
        canonicalKey,
        action: 'upsert',
        orgAgent: agent,
        updatedBy: userMail,
        updatedAt: now,
      });
    } catch (error) {
      console.error(
        `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(canonicalKey)} action=revalidate: ${sanitizeForLog(error)}`,
      );
    }
    return successResponse({ agent, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      service.invalidate();
      return errorResponse(
        'Agent was modified by another admin; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to revalidate org agent');
  }
}
