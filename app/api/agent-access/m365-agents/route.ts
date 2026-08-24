import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredM365Agent,
  createAgentAccessBlobStorage,
  deleteM365Agent,
  listAllM365Agents,
  readConfig,
  readM365Agent,
  writeM365Agent,
  writeM365AgentHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
  canEditKey,
  delegateToCreator,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  AgentAccessConfig,
  M365Agent,
  M365AgentHistoryEntry,
  M365AgentSource,
  M365_AGENT_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import {
  MAX_M365_AGENT_DOCUMENTS,
  purgeAgentFromIndex,
  purgeSourcesFromIndex,
} from '@/lib/services/m365/agentIndexService';
import { GRAPH_ID_REGEX } from '@/lib/services/m365/graphApi';

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
import { env } from '@/config/environment';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * GET/POST/PUT/DELETE /api/agent-access/m365-agents — admin CRUD for M365
 * file-backed RAG agents (docs/M365_SECOND_PASS_AGENTS_DESIGN.md). 404 while
 * agent access control is disabled. Any admin (global or local) may create —
 * the design decision from review; edits and deletes are authorized per
 * canonical key (`m365-agent::<id>`), exactly like the sibling entities.
 *
 * Writes only manage the agent RECORD; indexing runs separately via
 * ./index (it needs the caller's Graph token and can take minutes).
 */

const sourceFieldsSchema = z
  .object({
    driveId: z.string().trim().min(1).max(512).regex(GRAPH_ID_REGEX),
    itemId: z.string().trim().min(1).max(512).regex(GRAPH_ID_REGEX),
    kind: z.enum(['file', 'folder']).default('file'),
    title: z.string().trim().min(1).max(200),
    webUrl: z.string().trim().url().max(2000).or(z.literal('')).default(''),
    ownerDisplay: z.string().trim().max(120).optional(),
  })
  .strict();

const agentFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(300).default(''),
    systemPrompt: z.string().trim().max(10000).default(''),
    /** null → ride the catalog default at request time. */
    chatModelId: z.string().trim().min(1).max(100).nullable().default(null),
    topK: z.number().int().min(1).max(20).default(10),
    // Review decision: at most 10 documents per agent (folder expansion is
    // re-checked at index time).
    sources: z.array(sourceFieldsSchema).min(1).max(MAX_M365_AGENT_DOCUMENTS),
  })
  .strict();

const putBodySchema = agentFieldsSchema.extend({
  id: z.string().trim().min(1).max(100),
});

/**
 * Ids are server-generated, so a client-supplied one only ever needs to be
 * recognized — not parsed. Enforcing the exact shape keeps arbitrary strings
 * out of `m365AgentBlobPath`.
 */
const M365_AGENT_ID_PATTERN = /^m365-[a-f0-9]{12}$/;

const AGENT_MODEL_ID_PREFIXES = ['foundry-', 'org-', 'custom-', 'byom-'];

/** Same base-model contract as prompt agents; null is "ride the default". */
function validateChatModelId(modelId: string | null): string | null {
  if (modelId === null) return null;
  if (AGENT_MODEL_ID_PREFIXES.some((p) => modelId.startsWith(p))) {
    return 'chatModelId must be a base model, not an agent-backed id';
  }
  if (!Object.prototype.hasOwnProperty.call(OpenAIModels, modelId)) {
    return 'chatModelId is not a known model';
  }
  return null;
}

/**
 * Builds the persisted sources: sources that survive an edit (same
 * drive+item+kind) keep their sourceId and index status so their chunks stay
 * addressed; new ones start `pending` with a fresh server-generated id.
 */
function reconcileSources(
  incoming: z.infer<typeof sourceFieldsSchema>[],
  existing: M365AgentSource[],
): M365AgentSource[] {
  const byLocation = new Map(
    existing.map((s) => [`${s.driveId}:${s.itemId}:${s.kind}`, s]),
  );
  return incoming.map((source) => {
    const kept = byLocation.get(
      `${source.driveId}:${source.itemId}:${source.kind}`,
    );
    if (kept) {
      return {
        ...kept,
        title: source.title,
        webUrl: source.webUrl,
        ...(source.ownerDisplay !== undefined && {
          ownerDisplay: source.ownerDisplay,
        }),
      };
    }
    return {
      sourceId: `src-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      driveId: source.driveId,
      itemId: source.itemId,
      kind: source.kind,
      title: source.title,
      webUrl: source.webUrl,
      ...(source.ownerDisplay !== undefined && {
        ownerDisplay: source.ownerDisplay,
      }),
      status: 'pending' as const,
    };
  });
}

/** History failure must never fail the mutation (see guides route). */
async function appendHistoryBestEffort(
  entry: M365AgentHistoryEntry,
): Promise<void> {
  try {
    await writeM365AgentHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Best-effort removal of a just-created agent whose delegation could not be
 * recorded. Returns whether it is actually gone (see guides route for the
 * full rationale).
 */
async function rollbackCreate(
  id: string,
  etag: string,
  canonicalKey: string,
  userMail: string,
): Promise<boolean> {
  try {
    await deleteM365Agent(createAgentAccessBlobStorage(), id, etag);
    auditAdminWrite('m365-agent-delete', canonicalKey, userMail);
    return true;
  } catch (error) {
    console.error(
      `[agent-access-admin] ROLLBACK DELETE FAILED — m365 agent id=${sanitizeForLog(id)} key=${sanitizeForLog(canonicalKey)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
    );
    return false;
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
    let stored: StoredM365Agent[] = [];
    let config: AgentAccessConfig | null = null;
    let m365AgentsUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllM365Agents(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      console.error(
        `[agent-access-admin] direct m365-agents read failed: ${sanitizeForLog(error)}`,
      );
      m365AgentsUnavailable = true;
      config = service.getSnapshot().config;
    }

    const status = resolveAdminStatus(session.user, config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const visible =
      status.editableAgentKeys === ALL_AGENT_KEYS
        ? stored
        : stored.filter((entry) => canEditKey(status, entry.canonicalKey));

    return successResponse({
      m365Agents: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        agent: entry.m365Agent,
        etag: entry.etag,
      })),
      m365AgentsUnavailable,
      fetchedAt,
      // Env-configured cap, served so the editor's client-side limit always
      // matches what POST/PUT will actually accept.
      maxDocuments: MAX_M365_AGENT_DOCUMENTS,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list M365 agents');
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
  const parsed = agentFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid agent body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  const modelError = validateChatModelId(parsed.data.chatModelId);
  if (modelError) return badRequestResponse(modelError);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    // Any admin may create — global AND local (design decision from review).
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const id = `m365-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(M365_AGENT_SOURCE, id);
    const now = new Date().toISOString();
    const agent: M365Agent = {
      version: 1,
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      systemPrompt: parsed.data.systemPrompt,
      chatModelId: parsed.data.chatModelId,
      // Locked to the deployment the index vectors will be produced with;
      // per-agent embedding choice is a later phase (requires re-index).
      embeddingModelId: env.OPENAI_EMBEDDING_DEPLOYMENT,
      ragConfig: { topK: parsed.data.topK },
      sources: reconcileSources(parsed.data.sources, []),
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeM365Agent(
      createAgentAccessBlobStorage(),
      agent,
      null,
    );
    service.invalidate();
    auditAdminWrite('m365-agent-upsert', canonicalKey, userMail);

    if (!status.isGlobalAdmin) {
      const delegated = await delegateToCreator(userMail, canonicalKey);
      if (!delegated) {
        const rolledBack = await rollbackCreate(
          id,
          etag,
          canonicalKey,
          userMail,
        );
        service.invalidate();
        if (!rolledBack) {
          await appendHistoryBestEffort({
            version: 1,
            canonicalKey,
            action: 'upsert',
            m365Agent: agent,
            updatedBy: userMail,
            updatedAt: now,
          });
          return errorResponse(
            `Could not record delegation AND rollback failed: agent ${id} still exists without delegation and needs global-admin cleanup`,
            503,
          );
        }
        return errorResponse(
          'Could not record delegation; agent creation rolled back',
          503,
        );
      }
      service.invalidate();
    }

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      m365Agent: agent,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ agent, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to create M365 agent');
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
  if (!M365_AGENT_ID_PATTERN.test(parsed.data.id)) {
    return badRequestResponse('Invalid agent id');
  }
  const modelError = validateChatModelId(parsed.data.chatModelId);
  if (modelError) return badRequestResponse(modelError);

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(M365_AGENT_SOURCE, parsed.data.id);
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
    const existing = await readM365Agent(storage, parsed.data.id);
    if (!existing) return notFoundResponse('M365 agent');

    const now = new Date().toISOString();
    const sources = reconcileSources(
      parsed.data.sources,
      existing.m365Agent.sources,
    );
    const agent: M365Agent = {
      ...existing.m365Agent,
      name: parsed.data.name,
      description: parsed.data.description,
      systemPrompt: parsed.data.systemPrompt,
      chatModelId: parsed.data.chatModelId,
      ragConfig: { topK: parsed.data.topK },
      sources,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeM365Agent(storage, agent, ifMatchEtag);
    service.invalidate();
    auditAdminWrite('m365-agent-upsert', canonicalKey, userMail);

    // Sources dropped in this edit: purge their chunks (best-effort — an
    // orphaned chunk is unreachable anyway since retrieval filters by the
    // agent's CURRENT source ids).
    const keptIds = new Set(sources.map((s) => s.sourceId));
    const removedIds = existing.m365Agent.sources
      .map((s) => s.sourceId)
      .filter((sourceId) => !keptIds.has(sourceId));
    if (removedIds.length > 0) {
      await purgeSourcesFromIndex(agent.id, removedIds);
    }

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      m365Agent: agent,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ agent, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update M365 agent');
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
  if (!M365_AGENT_ID_PATTERN.test(id)) {
    return badRequestResponse('Invalid agent id');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
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

    const deleted = await deleteM365Agent(
      createAgentAccessBlobStorage(),
      id,
      ifMatchEtag,
    );
    if (!deleted) return notFoundResponse('M365 agent');

    service.invalidate();
    auditAdminWrite('m365-agent-delete', canonicalKey, userMail);

    // The design requires index purge on delete; best-effort (chunks with no
    // agent record are unreachable through retrieval regardless).
    await purgeAgentFromIndex(id);

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      m365Agent: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });
    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete M365 agent');
  }
}
