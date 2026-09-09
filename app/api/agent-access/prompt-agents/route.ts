import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredPromptAgent,
  createAgentAccessBlobStorage,
  deletePromptAgent,
  listAllPromptAgents,
  readConfig,
  readPromptAgent,
  writeConfig,
  writePromptAgent,
  writePromptAgentHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  AdminStatus,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  AgentAccessConfig,
  PROMPT_AGENT_SOURCE,
  PromptAgent,
  PromptAgentHistoryEntry,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

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
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * GET/POST/PUT/DELETE /api/agent-access/prompt-agents — admin CRUD for
 * app-defined prompt agents (persona = name + system prompt + model id).
 * 404 while the feature is disabled. Any admin (global or local — including
 * local admins with zero delegated keys) may create; edits and deletes are
 * authorized per canonical key (`prompt-agent::<id>`), exactly like rules.
 *
 * Writes are compare-and-swap: `If-Match: <etag>` for updates/deletes,
 * creates use `If-None-Match: *` in the store. Azure 412 → 409
 * AGENT_ACCESS_CONFLICT. Every successful mutation appends a best-effort
 * history blob and invalidates this replica's cache.
 */

// Only an exact quoted strong ETag may reach the storage CAS condition —
// `If-Match: *` matches any blob and would reduce the CAS to a blind write,
// and a weak validator (W/…) can never strong-match.
const STRONG_ETAG_REGEX = /^"[^"]*"$/;

/**
 * On a lost delegation CAS race the config is re-read and the append retried
 * this many times before the create is rolled back.
 */
const DELEGATION_CAS_ATTEMPTS = 3;

/**
 * WRITE-side schema only — stricter than the shared read schema in types.ts
 * (which must keep accepting every already-persisted blob). Trims stored
 * values clean; size caps bound admin-supplied payloads.
 */
const agentFieldsSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).default(''),
  systemPrompt: z.string().trim().min(1).max(10000),
  modelId: z.string().trim().min(1).max(100),
});

const putBodySchema = agentFieldsSchema.extend({
  id: z.string().trim().min(1).max(100),
});

/**
 * An agent-backed model id can't be a persona's engine (it would re-enter an
 * agent execution path); the id must resolve to a real base-model config so
 * the invocation-time model swap yields usable sdk/deployment settings.
 */
const AGENT_MODEL_ID_PREFIXES = ['foundry-', 'org-', 'custom-', 'byom-'];

function validateModelId(modelId: string): string | null {
  if (AGENT_MODEL_ID_PREFIXES.some((prefix) => modelId.startsWith(prefix))) {
    return 'modelId must be a base model, not an agent-backed id';
  }
  // hasOwnProperty (not `in`): a prototype name like 'constructor' must not
  // pass as a known model id.
  if (!Object.prototype.hasOwnProperty.call(OpenAIModels, modelId)) {
    return 'modelId is not a known model';
  }
  return null;
}

/** May this admin write the given canonical key? Keys are compared canonicalized. */
function canEditKey(status: AdminStatus, canonicalKey: string): boolean {
  if (status.editableAgentKeys === ALL_AGENT_KEYS) return true;
  return status.editableAgentKeys.some(
    (key) => key.trim().toLowerCase() === canonicalKey,
  );
}

function auditAdminWrite(
  action:
    | 'prompt-agent-upsert'
    | 'prompt-agent-delete'
    | 'prompt-agent-delegate',
  canonicalKey: string,
  updatedBy: string,
): void {
  console.log(
    `[agent-access-admin] action=${action} key=${sanitizeForLog(canonicalKey)} by=${sanitizeForLog(updatedBy)}`,
  );
}

/**
 * History is the durable audit trail but blob storage has no transactions:
 * by the time the entry is written the agent mutation has already landed, so
 * a history failure must not convert a successful save into a client-visible
 * error (a retry with the same If-Match would then 409). Log loudly instead.
 */
async function appendHistoryBestEffort(
  entry: PromptAgentHistoryEntry,
): Promise<void> {
  try {
    await writePromptAgentHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Records the just-created agent's canonical key on every localAdmins entry
 * matching the creator, so a local admin always ends up able to edit what
 * they created. CAS loop: on a lost race the config is re-read and the
 * append retried; any other failure (including a missing config/entry —
 * the delegation that authorized the create has vanished) returns false and
 * the caller rolls the create back.
 */
async function delegateToCreator(
  userMail: string,
  canonicalKey: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= DELEGATION_CAS_ATTEMPTS; attempt++) {
    try {
      const storage = createAgentAccessBlobStorage();
      const configResult = await readConfig(storage);
      const matchesCreator = (email: string) =>
        email.trim().toLowerCase() === userMail;
      if (
        !configResult ||
        !configResult.config.localAdmins.some((a) => matchesCreator(a.email))
      ) {
        console.error(
          `[agent-access-admin] delegation failed: no localAdmins entry for ${sanitizeForLog(userMail)}`,
        );
        return false;
      }
      const updated: AgentAccessConfig = {
        version: 1,
        localAdmins: configResult.config.localAdmins.map((admin) =>
          matchesCreator(admin.email) &&
          !admin.agentKeys.some(
            (key) => key.trim().toLowerCase() === canonicalKey,
          )
            ? { ...admin, agentKeys: [...admin.agentKeys, canonicalKey] }
            : admin,
        ),
        updatedBy: userMail,
        updatedAt: new Date().toISOString(),
      };
      await writeConfig(storage, updated, configResult.etag);
      auditAdminWrite('prompt-agent-delegate', canonicalKey, userMail);
      return true;
    } catch (error) {
      if (
        error instanceof AgentAccessConflictError &&
        attempt < DELEGATION_CAS_ATTEMPTS
      ) {
        // Another admin write won the CAS — re-read and retry.
        continue;
      }
      console.error(
        `[agent-access-admin] delegation write failed (attempt ${attempt}/${DELEGATION_CAS_ATTEMPTS}) for key=${sanitizeForLog(canonicalKey)}: ${sanitizeForLog(error)}`,
      );
      return false;
    }
  }
  return false;
}

/**
 * Best-effort removal of a just-created agent whose delegation could not be
 * recorded — a local admin must never end up owning an agent they cannot
 * edit. Returns whether the agent is actually gone: on false the blob
 * persists WITHOUT delegation (public under deny-list semantics, editable by
 * nobody but global admins) and the caller must say so instead of claiming a
 * rollback that did not happen.
 */
async function rollbackCreate(
  id: string,
  etag: string,
  canonicalKey: string,
  userMail: string,
): Promise<boolean> {
  try {
    // A false return means the blob was already absent — the rollback's goal
    // is met either way.
    await deletePromptAgent(createAgentAccessBlobStorage(), id, etag);
    auditAdminWrite('prompt-agent-delete', canonicalKey, userMail);
    return true;
  } catch (error) {
    console.error(
      `[agent-access-admin] ROLLBACK DELETE FAILED — agent id=${sanitizeForLog(id)} key=${sanitizeForLog(canonicalKey)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
    );
    return false;
  }
}

function conflictResponse(service: AgentAccessService) {
  // Another replica just won the CAS — refresh this replica's cached state
  // promptly instead of serving it stale for ≤60s.
  service.invalidate();
  return errorResponse(
    'Prompt agent was modified by another admin; reload and retry',
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
    // Read storage DIRECTLY (like the rules GET), not the ≤60s-stale service
    // snapshot: the etags echoed here feed the If-Match CAS, so after a 409
    // the UI's reload must observe the other replica's write immediately.
    let stored: StoredPromptAgent[] = [];
    let config: AgentAccessConfig | null = null;
    let promptAgentsUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllPromptAgents(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      // Same contract as the rules listing: storage outage → empty listing
      // flagged promptAgentsUnavailable, not a 500.
      console.error(
        `[agent-access-admin] direct prompt-agents read failed: ${sanitizeForLog(error)}`,
      );
      promptAgentsUnavailable = true;
      // The direct read exists for CAS-fresh etags, not authorization: when
      // it fails, authorize from the service's ≤60s-stale last-known-good
      // config so local admins receive the same degraded 200 as global
      // admins instead of a false 403 misreporting their adminship. A cold
      // replica with no snapshot still fails closed below.
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
      promptAgents: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        agent: entry.agent,
        etag: entry.etag,
      })),
      promptAgentsUnavailable,
      fetchedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list prompt agents');
  }
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  // No Graph mail → cannot be an admin (both admin registries are keyed on
  // mail), and createdBy would be unattributable.
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
      'Invalid prompt agent body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  const modelIdError = validateModelId(parsed.data.modelId);
  if (modelIdError) return badRequestResponse(modelIdError);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    // Any admin may create — including a local admin with zero delegated
    // keys (the created agent is auto-delegated to them below).
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    // Server-generated immutable id; the canonical key and blob path hang
    // off it, so renames never orphan rules or delegations.
    const id = `prompt-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(PROMPT_AGENT_SOURCE, id);
    const now = new Date().toISOString();
    const agent: PromptAgent = {
      version: 1,
      id,
      name: parsed.data.name,
      description: parsed.data.description,
      systemPrompt: parsed.data.systemPrompt,
      modelId: parsed.data.modelId,
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    // writePromptAgent derives the blob path from the record's own id, so
    // the key audited/delegated below is exactly the key being written.
    const etag = await writePromptAgent(
      createAgentAccessBlobStorage(),
      agent,
      null,
    );
    service.invalidate();
    auditAdminWrite('prompt-agent-upsert', canonicalKey, userMail);

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
          // The orphan is live: with no rule it is visible to every user
          // (deny-list semantics) and no local admin can edit or delete it.
          // Record it in the durable audit trail (creation history was not
          // yet written) and tell the client exactly what needs cleanup —
          // never claim a rollback that did not happen.
          await appendHistoryBestEffort({
            version: 1,
            canonicalKey,
            action: 'upsert',
            promptAgent: agent,
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
      // The config just changed too — admin status snapshots must refetch.
      service.invalidate();
    }

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      promptAgent: agent,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({ promptAgent: agent, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to create prompt agent');
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
      'Invalid prompt agent body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  const modelIdError = validateModelId(parsed.data.modelId);
  if (modelIdError) return badRequestResponse(modelIdError);

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(PROMPT_AGENT_SOURCE, parsed.data.id);

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

    // Updates are keyed on the body id — ids are immutable and
    // server-generated, so a PUT can never mint a new record.
    const existing = await readPromptAgent(
      createAgentAccessBlobStorage(),
      parsed.data.id,
    );
    if (existing === null) {
      return notFoundResponse('Prompt agent');
    }

    const now = new Date().toISOString();
    // Spread preserves id/createdBy/createdAt from the stored record.
    const agent: PromptAgent = {
      ...existing.agent,
      name: parsed.data.name,
      description: parsed.data.description,
      systemPrompt: parsed.data.systemPrompt,
      modelId: parsed.data.modelId,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writePromptAgent(
      createAgentAccessBlobStorage(),
      agent,
      ifMatchEtag,
    );
    service.invalidate();
    auditAdminWrite('prompt-agent-upsert', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      promptAgent: agent,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({ promptAgent: agent, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update prompt agent');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const id = request.nextUrl.searchParams.get('id');
  if (!id?.trim()) {
    return badRequestResponse('id query param is required');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(PROMPT_AGENT_SOURCE, id);

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

    // Delegation keys referencing this agent are left dangling in config
    // (render as unknown keys in the admin UI) — documented and acceptable.
    const deleted = await deletePromptAgent(
      createAgentAccessBlobStorage(),
      id.trim(),
      ifMatchEtag,
    );
    if (!deleted) {
      return notFoundResponse('Prompt agent');
    }
    service.invalidate();
    auditAdminWrite('prompt-agent-delete', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      promptAgent: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });

    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete prompt agent');
  }
}
