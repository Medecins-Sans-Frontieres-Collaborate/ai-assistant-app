/**
 * POST /api/agent-access/m365-agents/index  { id }
 *
 * Runs (re-)indexing for an M365 agent using the CALLING ADMIN'S delegated
 * Graph token — the constraint the whole design honors: refresh tokens
 * exist only inside the session JWT, so indexing runs only while someone
 * with file access is present. Synchronous (this route is the "job"); the
 * per-source outcomes are persisted onto the agent record and returned.
 *
 * Authorization matches PUT: the caller must be an admin holding the
 * agent's canonical key.
 */
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  readM365Agent,
  writeM365Agent,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import {
  auditAdminWrite,
  canEditKey,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  M365Agent,
  M365_AGENT_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import {
  AgentIndexRun,
  SourceIndexOutcome,
  indexAgentSources,
} from '@/lib/services/m365/agentIndexService';
import { M365Error, m365ErrorResponse } from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

export const maxDuration = 300;

const M365_AGENT_ID_PATTERN = /^m365-[a-f0-9]{12}$/;

function applyOutcomes(
  agent: M365Agent,
  outcomes: SourceIndexOutcome[],
  embeddingDeployment: string,
  now: string,
): M365Agent {
  const bySourceId = new Map(outcomes.map((o) => [o.sourceId, o]));
  return {
    ...agent,
    // Stamp what this run actually embedded with — retrieval embeds
    // queries with this value, and it must match the index's vectors.
    // On a PARTIAL run a failed source may retain chunks from the previous
    // deployment; its error status is loud in the admin UI and the next
    // successful re-index converges it.
    embeddingModelId: embeddingDeployment,
    sources: agent.sources.map((source) => {
      const outcome = bySourceId.get(source.sourceId);
      if (!outcome) return source;
      return {
        ...source,
        status: outcome.status,
        indexedChunks: outcome.indexedChunks,
        ...(outcome.status === 'indexed' && { lastIndexedAt: now }),
        ...(outcome.error ? { error: outcome.error } : { error: undefined }),
      };
    }),
  };
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
  const id =
    typeof body === 'object' && body !== null && 'id' in body
      ? String((body as { id: unknown }).id).trim()
      : '';
  if (!M365_AGENT_ID_PATTERN.test(id)) {
    return badRequestResponse('Invalid agent id');
  }

  const canonicalKey = canonicalAgentKey(M365_AGENT_SOURCE, id);
  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this agent key');
    }

    const storage = createAgentAccessBlobStorage();
    const existing = await readM365Agent(storage, id);
    if (!existing) return notFoundResponse('M365 agent');

    // The long part: download → extract → chunk → embed → upload, with the
    // caller's Graph token. Consent gaps / disconnected sessions surface as
    // typed M365 errors, not generic 500s.
    let run: AgentIndexRun;
    try {
      run = await indexAgentSources(request, existing.m365Agent);
    } catch (error) {
      if (error instanceof M365Error) return m365ErrorResponse(error);
      throw error;
    }
    const { outcomes, embeddingDeployment } = run;

    // Persist outcomes onto the LATEST record (an admin may have edited the
    // agent while indexing ran; statuses attach by stable sourceId).
    const now = new Date().toISOString();
    const latest = await readM365Agent(storage, id);
    if (!latest) return notFoundResponse('M365 agent');
    const updated = applyOutcomes(
      latest.m365Agent,
      outcomes,
      embeddingDeployment,
      now,
    );
    let etag: string;
    try {
      etag = await writeM365Agent(storage, updated, latest.etag);
    } catch (error) {
      if (error instanceof AgentAccessConflictError) {
        // Someone edited during the final write — the index itself is
        // correct; only the status annotations lost the race.
        service.invalidate();
        return errorResponse(
          'Indexing finished but statuses could not be recorded; reload',
          409,
          undefined,
          'AGENT_ACCESS_CONFLICT',
        );
      }
      throw error;
    }
    service.invalidate();
    auditAdminWrite('m365-agent-index', canonicalKey, userMail);

    return successResponse({ agent: updated, etag, outcomes });
  } catch (error) {
    return handleApiError(error, 'Failed to index M365 agent');
  }
}
