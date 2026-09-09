/**
 * POST /api/agent-access/m365-agents/plan  { sources: [...] }
 *
 * The plan phase (docs/M365_SEVENTH_PASS_RECURSIVE_AGENT_SOURCES.md §1):
 * enumerates the given sources with the CALLING ADMIN'S Graph token —
 * metadata only, nothing downloaded — and returns every file classified
 * (indexable / needs preparation / skipped + reason), the folder tree for
 * exclusions, and cap accounting. The editor calls this on Add and on
 * every selection change; POST/PUT and the index run re-run the same
 * planner, so the numbers shown are the numbers enforced.
 *
 * Any admin may plan: enumeration reveals nothing the caller's own token
 * could not list directly, and no agent record is touched.
 */
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import { createAgentAccessBlobStorage } from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import { canEditKey } from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  M365DerivedIndexEntry,
  M365_AGENT_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import { readDerivedIndex } from '@/lib/services/m365/agentDerivedTextStore';
import { planSources } from '@/lib/services/m365/agentSourcePlanner';
import {
  GRAPH_ID_REGEX,
  M365Error,
  m365ErrorResponse,
} from '@/lib/services/m365/graphApi';

import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { z } from 'zod';

export const maxDuration = 120;

const planSourceSchema = z
  .object({
    driveId: z.string().trim().min(1).max(512).regex(GRAPH_ID_REGEX),
    itemId: z.string().trim().min(1).max(512).regex(GRAPH_ID_REGEX),
    kind: z.enum(['file', 'folder']).default('file'),
    recursive: z.boolean().default(false),
    excludedItemIds: z
      .array(z.string().trim().min(1).max(512).regex(GRAPH_ID_REGEX))
      .max(500)
      .default([]),
    includeExtensions: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[a-z0-9]{1,10}$/),
      )
      .max(30)
      .optional(),
  })
  .strict();

const bodySchema = z
  .object({
    sources: z.array(planSourceSchema).min(1).max(200),
    /**
     * Existing agent being edited: its prepared files (phase 4) are
     * applied so the plan matches what an index run would do. Ignored
     * unless the caller holds the agent's key.
     */
    agentId: z
      .string()
      .trim()
      .regex(/^m365-[a-f0-9]{12}$/)
      .optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid plan body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    let prepared: Record<string, M365DerivedIndexEntry> | undefined;
    if (
      parsed.data.agentId &&
      canEditKey(
        status,
        canonicalAgentKey(M365_AGENT_SOURCE, parsed.data.agentId),
      )
    ) {
      try {
        prepared = (
          await readDerivedIndex(
            createAgentAccessBlobStorage(),
            parsed.data.agentId,
          )
        ).index.items;
      } catch {
        prepared = undefined; // plan without preparation info
      }
    }

    let plan;
    try {
      plan = await planSources(
        request,
        session.user.id,
        parsed.data.sources.map((source) => ({ ...source, prepared })),
      );
    } catch (error) {
      if (error instanceof M365Error) return m365ErrorResponse(error);
      throw error;
    }
    return successResponse({
      ...plan,
      plans: plan.plans.map((sourcePlan, index) => ({
        driveId: parsed.data.sources[index].driveId,
        itemId: parsed.data.sources[index].itemId,
        ...sourcePlan,
      })),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to plan M365 agent sources');
  }
}
