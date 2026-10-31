import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredSkill,
  createAgentAccessBlobStorage,
  deleteSkill,
  listAllSkills,
  readConfig,
  readSkill,
  writeSkill,
  writeSkillHistoryEntry,
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
  SKILL_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import {
  BUILTIN_SKILL_IDS,
  getBuiltinSkill,
} from '@/lib/services/skills/builtinSkills';
import { orgSkillsAvailable } from '@/lib/services/skills/skillCatalog';
import {
  discardSkillFiles,
  storeSkillFiles,
} from '@/lib/services/skills/skillDocumentStore';
import { startSkillMaintenance } from '@/lib/services/skills/skillMaintenance';
import { readSkillMultipart } from '@/lib/services/skills/skillMultipart';
import { deleteSkillChunks } from '@/lib/services/skills/skillSearch';
import {
  Skill,
  SkillHistoryEntry,
  SkillIdSchema,
  SkillWriteFieldsSchema,
} from '@/lib/services/skills/types';

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
import { env } from '@/config/environment';

/**
 * GET/POST/PUT/DELETE /api/agent-access/skills — admin CRUD for skills
 * (docs/SKILLS_DESIGN.md §4, §11). 404 while agent access control (the
 * storage org skills ride) is off. Any admin (global or local) may create; edits and
 * deletes are authorized per canonical key (`skill::<id>`), exactly like
 * guides.
 *
 * Divergences from the guides route, both deliberate:
 * - Ids are AUTHOR-CHOSEN, not server-generated: a skill id is its Agent
 *   Skills `name` (the SKILL.md interchange identity) and, later, its
 *   composer handle — `gdpr`, not `skill-3f2a...`. SkillIdSchema constrains
 *   the charset (safe for blob paths), and the create-only CAS turns an id
 *   collision into a 409.
 * - No payload split: whole records at prompt-agent scale (16 KB cap).
 *
 * Built-ins: a record whose id matches a compiled built-in is an OVERRIDE —
 * created by POST like any skill, PUT-edited, and DELETE restores the
 * compiled default. The listing marks provenance so the panel can say
 * "default" vs "customized".
 */

function skillsRouteEnabled(service: AgentAccessService): boolean {
  return service.isEnabled() && orgSkillsAvailable();
}

function conflictResponse(service: AgentAccessService) {
  // Another replica just won the CAS — refresh this replica's cached state
  // promptly instead of serving it stale for ≤60s.
  service.invalidate();
  return errorResponse(
    'Skill was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

/** See the guides route: history is best-effort AFTER the landed mutation. */
async function appendHistoryBestEffort(entry: SkillHistoryEntry) {
  try {
    await writeSkillHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Best-effort removal of a just-created skill whose delegation could not be
 * recorded — a local admin must never end up owning a skill they cannot
 * edit. Returns whether it is actually gone (see the guides route).
 */
async function rollbackCreate(
  id: string,
  etag: string,
  canonicalKey: string,
  userMail: string,
): Promise<boolean> {
  try {
    await deleteSkill(createAgentAccessBlobStorage(), id, etag);
    auditAdminWrite('skill-delete', canonicalKey, userMail);
    return true;
  } catch (error) {
    console.error(
      `[agent-access-admin] ROLLBACK DELETE FAILED — skill id=${sanitizeForLog(id)} key=${sanitizeForLog(canonicalKey)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
    );
    return false;
  }
}

export async function GET() {
  // Feature flag BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  const service = AgentAccessService.getInstance();
  if (!skillsRouteEnabled(service)) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    // Read storage DIRECTLY (like the guides GET), not the ≤60s-stale
    // service snapshot: the etags echoed here feed the If-Match CAS.
    let stored: StoredSkill[] = [];
    let config: AgentAccessConfig | null = null;
    let skillsUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllSkills(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      // Storage outage → degraded 200 (built-ins still listed), not a 500;
      // authorize from the service's last-known-good config.
      console.error(
        `[agent-access-admin] direct skills read failed: ${sanitizeForLog(error)}`,
      );
      skillsUnavailable = true;
      config = service.getSnapshot().config;
    }

    const status = resolveAdminStatus(session.user, config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    startSkillMaintenance(createAgentAccessBlobStorage());

    const storedById = new Map(stored.map((entry) => [entry.record.id, entry]));

    // Built-ins first (override record shown when one exists), then org
    // skills. etag null = compiled default, nothing stored to CAS against.
    const entries = [
      ...[...BUILTIN_SKILL_IDS].map((id) => {
        const override =
          status.isGlobalAdmin ||
          canEditKey(status, canonicalAgentKey(SKILL_SOURCE, id))
            ? storedById.get(id)
            : undefined;
        return {
          canonicalKey: canonicalAgentKey(SKILL_SOURCE, id),
          skill: override?.record ?? getBuiltinSkill(id)!,
          etag: override?.etag ?? null,
          builtin: true,
          overridden: !!override,
        };
      }),
      ...stored
        .filter((entry) => !BUILTIN_SKILL_IDS.has(entry.record.id))
        .sort((a, b) => a.record.id.localeCompare(b.record.id))
        .map((entry) => ({
          canonicalKey: entry.canonicalKey,
          skill: entry.record,
          etag: entry.etag as string | null,
          builtin: false,
          overridden: false,
        })),
    ];

    // Local admins see built-ins read-only context plus their own keys;
    // like the guides GET, write authorization is re-checked per verb.
    const visible =
      status.editableAgentKeys === ALL_AGENT_KEYS
        ? entries
        : entries.filter(
            (entry) => entry.builtin || canEditKey(status, entry.canonicalKey),
          );

    return successResponse({
      skills: visible.map((entry) => ({
        ...entry,
        editable:
          status.isGlobalAdmin ||
          (!entry.builtin && canEditKey(status, entry.canonicalKey)),
        requiresReindex: entry.skill.documents?.some(
          (doc) =>
            doc.indexStatus === 'indexed' &&
            (doc.embeddingRegion !== env.SKILLS_DATA_REGION ||
              doc.searchIndex !== env.SKILLS_SEARCH_INDEX ||
              doc.searchEndpoint !==
                ((env.SKILLS_DATA_REGION === 'EU'
                  ? env.SKILLS_SEARCH_ENDPOINT_EU
                  : env.SKILLS_SEARCH_ENDPOINT_US) ??
                  env.SKILLS_SEARCH_ENDPOINT)),
        ),
      })),
      skillsUnavailable,
      fetchedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list skills');
  }
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!skillsRouteEnabled(service)) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  // No Graph mail → cannot be an admin (both admin registries are keyed on
  // mail), and createdBy would be unattributable.
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  let files: File[] = [];
  try {
    if (
      request.headers.get('content-type')?.startsWith('multipart/form-data')
    ) {
      const form = await readSkillMultipart(request);
      body = JSON.parse(String(form.get('fields')));
      files = form
        .getAll('files')
        .filter((file): file is File => file instanceof File);
    } else body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = SkillWriteFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid skill body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  const canonicalKey = canonicalAgentKey(SKILL_SOURCE, parsed.data.id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    // Any admin may create — including a local admin with zero delegated
    // keys (the created skill is auto-delegated to them below). Overriding
    // a BUILT-IN is org-wide configuration though: global admins only.
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    const isBuiltinOverride = BUILTIN_SKILL_IDS.has(parsed.data.id);
    if (isBuiltinOverride && !status.isGlobalAdmin) {
      return forbiddenResponse('Built-in skills are managed by global admins');
    }

    const storage = createAgentAccessBlobStorage();
    const documents = await storeSkillFiles(
      storage,
      parsed.data.id,
      files,
      userMail,
    );
    const now = new Date().toISOString();
    const skill: Skill = {
      version: 1,
      ...parsed.data,
      documents,
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    // Create-only CAS: an id collision (someone else took the name, or an
    // override already exists) surfaces as a 409, never an overwrite.
    let etag: string;
    try {
      etag = await writeSkill(storage, skill, null);
    } catch (error) {
      await discardSkillFiles(storage, skill.id, documents);
      throw error;
    }
    service.invalidate();
    auditAdminWrite('skill-upsert', canonicalKey, userMail);

    if (!status.isGlobalAdmin) {
      const delegated = await delegateToCreator(userMail, canonicalKey);
      if (!delegated) {
        const rolledBack = await rollbackCreate(
          skill.id,
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
            skill,
            updatedBy: userMail,
            updatedAt: now,
          });
          return errorResponse(
            `Could not record delegation AND rollback failed: skill ${skill.id} still exists without delegation and needs global-admin cleanup`,
            503,
          );
        }
        await discardSkillFiles(storage, skill.id, documents);
        return errorResponse(
          'Could not record delegation; skill creation rolled back',
          503,
        );
      }
      service.invalidate();
    }

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      skill,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({ skill, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to create skill');
  }
}

export async function PUT(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!skillsRouteEnabled(service)) return notFoundResponse('Resource');

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
  const parsed = SkillWriteFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid skill body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(SKILL_SOURCE, parsed.data.id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (BUILTIN_SKILL_IDS.has(parsed.data.id) && !status.isGlobalAdmin) {
      return forbiddenResponse('Built-in skills are managed by global admins');
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this skill key');
    }

    // Updates are keyed on the body id — the id is the record's identity
    // (blob path, canonical key, SKILL.md name), so a PUT can never rename.
    const existing = await readSkill(
      createAgentAccessBlobStorage(),
      parsed.data.id,
    );
    if (existing === null) {
      return notFoundResponse('Skill');
    }

    const now = new Date().toISOString();
    // Constructed explicitly — never spread over existing.skill: the
    // permissive read schema would keep stale fields forever. Only
    // id/createdBy/createdAt/documents survive from the stored record
    // (documents are phase-3 state this route does not manage).
    const skill: Skill = {
      version: 1,
      ...parsed.data,
      documents: existing.skill.documents,
      // A sourced skill stays attached to its source when an admin adjusts
      // its flags (§12: admin-governed flags survive refreshes).
      ...(existing.skill.source ? { source: existing.skill.source } : {}),
      createdBy: existing.skill.createdBy,
      createdAt: existing.skill.createdAt,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeSkill(
      createAgentAccessBlobStorage(),
      skill,
      ifMatchEtag,
    );
    service.invalidate();
    auditAdminWrite('skill-upsert', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      skill,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({ skill, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update skill');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!skillsRouteEnabled(service)) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const rawId = request.nextUrl.searchParams.get('id');
  const idParsed = SkillIdSchema.safeParse(rawId?.trim());
  if (!idParsed.success) {
    return badRequestResponse('id is not a valid skill id');
  }
  const id = idParsed.data;

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(SKILL_SOURCE, id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (BUILTIN_SKILL_IDS.has(id) && !status.isGlobalAdmin) {
      return forbiddenResponse('Built-in skills are managed by global admins');
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this skill key');
    }

    // For a built-in id this deletes the OVERRIDE record — the compiled
    // default takes effect again; the built-in itself cannot be deleted.
    const storage = createAgentAccessBlobStorage();
    const existing = await readSkill(storage, id);
    const deleted = await deleteSkill(storage, id, ifMatchEtag);
    if (!deleted) {
      return notFoundResponse('Skill');
    }
    service.invalidate();
    if (existing) {
      await discardSkillFiles(storage, id, existing.skill.documents);
      for (const document of existing.skill.documents) {
        try {
          await deleteSkillChunks(document.fileId, document.chunkCount ?? 300);
        } catch (error) {
          console.error('[skills] Search cleanup after deletion failed', error);
        }
      }
    }
    auditAdminWrite('skill-delete', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      skill: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });

    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete skill');
  }
}
