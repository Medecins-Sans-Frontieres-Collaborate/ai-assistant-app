import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredOrgRagAgent,
  createAgentAccessBlobStorage,
  deleteOrgAgent,
  listAllOrgAgents,
  readConfig,
  readOrgAgent,
  writeOrgAgent,
  writeOrgAgentHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
  canEditKey,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  AgentAccessConfig,
  ORG_AGENT_SOURCE,
  OrgRagAgent,
  OrgRagAgentHistoryEntry,
  SEARCH_INDEX_NAME_REGEX,
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

import { OpenAIModels } from '@/types/openai';

import { auth } from '@/auth';
import { getOrganizationAgents } from '@/lib/organizationAgents';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * GET/POST/PUT/DELETE /api/agent-access/org-agents — admin CRUD for
 * organization RAG agents (the blob-store counterpart of
 * config/organization-agents.json). 404 while agent access control is
 * disabled.
 *
 * Deviation from the sibling m365-agents route: creation is GLOBAL admins
 * only — these are org-wide knowledge agents over shared search indexes,
 * not personal file collections. Edits/deletes still authorize per
 * canonical key (`org-agent::<id>`) so delegation keeps working if a
 * global admin ever grants it.
 *
 * Every write re-runs the Azure AI Search validation
 * (orgAgentSearchValidation.ts) and persists the outcome on the record; a
 * failed validation SAVES (so an admin can stage an agent while its index
 * is still being built) but the registry refuses to serve it.
 */

const agentFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(300).default(''),
    icon: z
      .string()
      .trim()
      .regex(/^Icon[A-Za-z][A-Za-z0-9]{0,63}$/)
      .default('IconHexagon'),
    color: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .default('#4190f2'),
    category: z.string().trim().max(100).default(''),
    maintainedBy: z.string().trim().max(120).default(''),
    systemPrompt: z.string().trim().max(20000).default(''),
    sources: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(200),
            url: z
              .string()
              .trim()
              .url()
              .max(2000)
              .or(z.literal(''))
              .default(''),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    searchIndex: z.string().trim().regex(SEARCH_INDEX_NAME_REGEX),
    semanticConfig: z.string().trim().max(200).default(''),
    topK: z.number().int().min(1).max(20).default(10),
    /** null → ride the catalog default at request time. */
    baseModelId: z.string().trim().min(1).max(100).nullable().default(null),
    allowWebSearch: z.boolean().default(false),
    allowCodeInterpreter: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();

const postBodySchema = agentFieldsSchema.extend({
  /**
   * Static config agent id to override. When set, the record's id becomes
   * this id, so the registry's merge replaces the file entry.
   */
  overrideId: z.string().trim().min(1).max(100).optional(),
});

const putBodySchema = agentFieldsSchema.extend({
  id: z.string().trim().min(1).max(100),
});

/**
 * Server-generated ids only need to be recognized, not parsed. Overrides
 * additionally admit the ids of static config agents (checked separately —
 * the set is known at build time).
 */
const ORG_AGENT_ID_PATTERN = /^orgr-[a-f0-9]{12}$/;

const AGENT_MODEL_ID_PREFIXES = ['foundry-', 'org-', 'custom-', 'byom-'];

/** Same base-model contract as prompt/m365 agents; null rides the default. */
function validateBaseModelId(modelId: string | null): string | null {
  if (modelId === null) return null;
  if (AGENT_MODEL_ID_PREFIXES.some((p) => modelId.startsWith(p))) {
    return 'baseModelId must be a base model, not an agent-backed id';
  }
  if (!Object.prototype.hasOwnProperty.call(OpenAIModels, modelId)) {
    return 'baseModelId is not a known model';
  }
  return null;
}

function staticAgentIds(): Set<string> {
  return new Set(getOrganizationAgents().map((agent) => agent.id));
}

function isKnownOrgAgentId(id: string): boolean {
  return ORG_AGENT_ID_PATTERN.test(id) || staticAgentIds().has(id);
}

/** History failure must never fail the mutation (see guides route). */
async function appendHistoryBestEffort(
  entry: OrgRagAgentHistoryEntry,
): Promise<void> {
  try {
    await writeOrgAgentHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

function conflictResponse(service: AgentAccessService) {
  service.invalidate();
  return errorResponse(
    'Agent was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

export async function GET() {
  // Feature flag BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    // Read storage DIRECTLY (like the sibling GETs), not the ≤60s-stale
    // service snapshot: the etags echoed here feed the If-Match CAS.
    let stored: StoredOrgRagAgent[] = [];
    let config: AgentAccessConfig | null = null;
    let orgAgentsUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllOrgAgents(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      console.error(
        `[agent-access-admin] direct org-agents read failed: ${sanitizeForLog(error)}`,
      );
      orgAgentsUnavailable = true;
      config = service.getSnapshot().config;
    }

    const status = resolveAdminStatus(session.user.mail, config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const visible =
      status.editableAgentKeys === ALL_AGENT_KEYS
        ? stored
        : stored.filter((entry) => canEditKey(status, entry.canonicalKey));

    return successResponse({
      orgAgents: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        agent: entry.orgAgent,
        etag: entry.etag,
      })),
      orgAgentsUnavailable,
      fetchedAt,
      // Static config ids the editor may offer as override targets.
      staticAgentIds: Array.from(staticAgentIds()),
      canCreate: status.isGlobalAdmin,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list org agents');
  }
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
  const parsed = postBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid agent body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  const modelError = validateBaseModelId(parsed.data.baseModelId);
  if (modelError) return badRequestResponse(modelError);
  if (
    parsed.data.overrideId !== undefined &&
    !staticAgentIds().has(parsed.data.overrideId)
  ) {
    return badRequestResponse(
      'overrideId must be the id of a static organization agent',
    );
  }

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    // Global admins only — org-wide knowledge agents (see module doc).
    if (!status.isGlobalAdmin) return forbiddenResponse();

    const id =
      parsed.data.overrideId ??
      `orgr-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(ORG_AGENT_SOURCE, id);
    const now = new Date().toISOString();
    const validation = await validateOrgAgentIndex(
      parsed.data.searchIndex,
      parsed.data.semanticConfig,
    );
    const agent: OrgRagAgent = {
      version: 1,
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      icon: parsed.data.icon,
      color: parsed.data.color,
      category: parsed.data.category,
      maintainedBy: parsed.data.maintainedBy,
      systemPrompt: parsed.data.systemPrompt,
      sources: parsed.data.sources,
      searchIndex: parsed.data.searchIndex,
      semanticConfig: parsed.data.semanticConfig,
      topK: parsed.data.topK,
      baseModelId: parsed.data.baseModelId,
      allowWebSearch: parsed.data.allowWebSearch,
      allowCodeInterpreter: parsed.data.allowCodeInterpreter,
      enabled: parsed.data.enabled,
      validation,
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeOrgAgent(
      createAgentAccessBlobStorage(),
      agent,
      null,
    );
    service.invalidate();
    // A fresh save-time validation supersedes any cached serve-time recheck.
    clearIndexServeableCache();
    auditAdminWrite('org-agent-upsert', canonicalKey, userMail);

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      orgAgent: agent,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ agent, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to create org agent');
  }
}

export async function PUT(request: NextRequest) {
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
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid agent body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  if (!isKnownOrgAgentId(parsed.data.id)) {
    return badRequestResponse('Invalid agent id');
  }
  const modelError = validateBaseModelId(parsed.data.baseModelId);
  if (modelError) return badRequestResponse(modelError);

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
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

    const now = new Date().toISOString();
    const validation = await validateOrgAgentIndex(
      parsed.data.searchIndex,
      parsed.data.semanticConfig,
    );
    const agent: OrgRagAgent = {
      ...existing.orgAgent,
      name: parsed.data.name,
      description: parsed.data.description,
      icon: parsed.data.icon,
      color: parsed.data.color,
      category: parsed.data.category,
      maintainedBy: parsed.data.maintainedBy,
      systemPrompt: parsed.data.systemPrompt,
      sources: parsed.data.sources,
      searchIndex: parsed.data.searchIndex,
      semanticConfig: parsed.data.semanticConfig,
      topK: parsed.data.topK,
      baseModelId: parsed.data.baseModelId,
      allowWebSearch: parsed.data.allowWebSearch,
      allowCodeInterpreter: parsed.data.allowCodeInterpreter,
      enabled: parsed.data.enabled,
      validation,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeOrgAgent(storage, agent, ifMatchEtag);
    service.invalidate();
    // A fresh save-time validation supersedes any cached serve-time recheck.
    clearIndexServeableCache();
    auditAdminWrite('org-agent-upsert', canonicalKey, userMail);

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      orgAgent: agent,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ agent, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update org agent');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const id = request.nextUrl.searchParams.get('id')?.trim() ?? '';
  if (!id) return badRequestResponse('id query param is required');
  if (!isKnownOrgAgentId(id)) {
    return badRequestResponse('Invalid agent id');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(ORG_AGENT_SOURCE, id);
  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this agent key');
    }

    // Deliberately leaves any access RULE for this key in place (all entity
    // deletes do). For the other entities that is dead data — their ids are
    // random hex and never reused — but org-agent OVERRIDES reuse static
    // config ids, so a rule survives a delete/recreate cycle and re-applies
    // to the new record. Fail-closed by construction: a restriction can
    // only ever be dropped by an explicit rule delete, never as a side
    // effect of recycling the agent record.
    const deleted = await deleteOrgAgent(
      createAgentAccessBlobStorage(),
      id,
      ifMatchEtag,
    );
    if (!deleted) return notFoundResponse('Org agent');

    service.invalidate();
    auditAdminWrite('org-agent-delete', canonicalKey, userMail);

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      orgAgent: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });
    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete org agent');
  }
}
