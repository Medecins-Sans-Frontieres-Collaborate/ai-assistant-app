import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredGuide,
  createAgentAccessBlobStorage,
  deleteGuide,
  listAllGuides,
  readConfig,
  readGuide,
  writeGuide,
  writeGuideHistoryEntry,
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
  GUIDE_SOURCE,
  Guide,
  GuideHistoryEntry,
  GuideWorkflowSchema,
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
import {
  MAX_GUIDE_BODY_CHARS,
  MAX_GUIDE_ENTRIES,
  MAX_GUIDE_GENERAL_GUIDANCE_CHARS,
  MAX_GUIDE_NAME_CHARS,
  MAX_GUIDE_SECTIONS,
  MAX_GUIDE_SECTION_GUIDANCE_CHARS,
  MAX_GUIDE_SECTION_HEADING_CHARS,
  MAX_GUIDE_TERM_CHARS,
  MAX_GUIDE_TERM_NOTE_CHARS,
  MAX_GUIDE_VOICE_CHARS,
} from '@/lib/utils/shared/review/guideCriteria';

import { auth } from '@/auth';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * GET/POST/PUT/DELETE /api/agent-access/guides — admin CRUD for admin-authored
 * workflow guides (office style guides, terminology glossaries, compliance
 * checklists, document structure specs, tone profiles). 404 while the feature
 * is disabled. Any admin (global or local) may create; edits and deletes are
 * authorized per canonical key (`guide::<id>`), exactly like rules, prompt
 * agents, and connectors.
 *
 * Guide bodies are long by design — they exist to escape the client-sent
 * custom-criterion rubric cap — so the write bound here (MAX_GUIDE_BODY_CHARS)
 * is a storage sanity limit, not a prompt budget; injection applies its own
 * token budget.
 */

/**
 * WRITE-side schema — stricter than the shared permissive read schema in
 * types.ts, and kind-DISCRIMINATED where the read schema is flat: each kind
 * accepts exactly its own payload fields (`.strict()` rejects the rest, so a
 * `body` on a tone guide is a 400, not silently-stored dead weight).
 * Long-form text fields (body/voiceRules/examples/guidance) are deliberately
 * NOT trimmed: they are markdown and leading/trailing whitespace can be
 * meaningful (code fences, list indentation).
 */
const guideBaseFields = {
  name: z.string().trim().min(1).max(MAX_GUIDE_NAME_CHARS),
  description: z.string().trim().max(300).default(''),
  languages: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  workflows: z.array(GuideWorkflowSchema).min(1).max(2),
};

const bodyKindFields = {
  ...guideBaseFields,
  body: z.string().min(1).max(MAX_GUIDE_BODY_CHARS),
};

const guideFieldsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('style'), ...bodyKindFields }).strict(),
  z.object({ kind: z.literal('compliance'), ...bodyKindFields }).strict(),
  z
    .object({
      kind: z.literal('tone'),
      ...guideBaseFields,
      voiceRules: z.string().min(1).max(MAX_GUIDE_VOICE_CHARS),
      examples: z.string().max(MAX_GUIDE_VOICE_CHARS).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('structure'),
      ...guideBaseFields,
      sections: z
        .array(
          z
            .object({
              heading: z
                .string()
                .trim()
                .min(1)
                .max(MAX_GUIDE_SECTION_HEADING_CHARS),
              guidance: z
                .string()
                .max(MAX_GUIDE_SECTION_GUIDANCE_CHARS)
                .optional(),
              required: z.boolean(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_GUIDE_SECTIONS),
      generalGuidance: z
        .string()
        .max(MAX_GUIDE_GENERAL_GUIDANCE_CHARS)
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('terminology'),
      ...guideBaseFields,
      entries: z
        .array(
          z
            .object({
              source: z.string().trim().min(1).max(MAX_GUIDE_TERM_CHARS),
              target: z.string().trim().min(1).max(MAX_GUIDE_TERM_CHARS),
              note: z.string().max(MAX_GUIDE_TERM_NOTE_CHARS).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_GUIDE_ENTRIES),
    })
    .strict(),
]);

type GuideFields = z.infer<typeof guideFieldsSchema>;

/**
 * PUT bodies are `{ id } + kind variant`. The variants are `.strict()`, so
 * `id` is peeled off first and the remainder goes through the same
 * discriminated union as POST — one validation source for both verbs.
 */
const putIdSchema = z
  .object({ id: z.string().trim().min(1).max(100) })
  .passthrough();

function parsePutBody(
  body: unknown,
):
  | { success: true; id: string; fields: GuideFields }
  | { success: false; issues: string } {
  const idParsed = putIdSchema.safeParse(body);
  if (!idParsed.success) {
    return { success: false, issues: 'id' };
  }
  const { id, ...rest } = idParsed.data;
  const fieldsParsed = guideFieldsSchema.safeParse(rest);
  if (!fieldsParsed.success) {
    return {
      success: false,
      issues: fieldsParsed.error.issues.map((i) => i.path.join('.')).join(', '),
    };
  }
  return { success: true, id, fields: fieldsParsed.data };
}

/**
 * The active kind's payload fields, and ONLY those — used by both POST and
 * PUT so a record can never carry another kind's leftovers (the permissive
 * read schema would keep them forever).
 */
function payloadFieldsOf(fields: GuideFields): Partial<Guide> {
  switch (fields.kind) {
    case 'style':
    case 'compliance':
      return { body: fields.body };
    case 'tone':
      return { voiceRules: fields.voiceRules, examples: fields.examples };
    case 'structure':
      return {
        sections: fields.sections,
        generalGuidance: fields.generalGuidance,
      };
    case 'terminology':
      return { entries: fields.entries };
  }
}

/**
 * Ids are server-generated, so a client-supplied one only ever needs to be
 * recognized — not parsed. Enforcing the exact shape keeps arbitrary strings
 * out of `guideBlobPath`.
 */
const GUIDE_ID_PATTERN = /^guide-[a-f0-9]{12}$/;

/**
 * Cross-field validation the zod schema can't express. Returns an error
 * message, or null when the payload is coherent.
 */
function validateGuideFields(
  fields: z.infer<typeof guideFieldsSchema>,
): string | null {
  if (
    (fields.kind === 'structure' || fields.kind === 'tone') &&
    (fields.workflows.length !== 1 || fields.workflows[0] !== 'document')
  ) {
    // These kinds fill the document workflow's spec/tone attachment slots;
    // the translation workflow has no such slots to fill.
    return 'structure and tone guides are only available in the document workflow';
  }
  return null;
}

/** Deduped, order-preserving workflows list. */
function normalizeWorkflows(workflows: Guide['workflows']): Guide['workflows'] {
  return [...new Set(workflows)];
}

/**
 * History is the durable audit trail but blob storage has no transactions: by
 * the time the entry is written the guide mutation has already landed, so a
 * history failure must not convert a successful save into a client-visible
 * error (a retry with the same If-Match would then 409). Log loudly instead.
 */
async function appendHistoryBestEffort(
  entry: GuideHistoryEntry,
): Promise<void> {
  try {
    await writeGuideHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Best-effort removal of a just-created guide whose delegation could not be
 * recorded — a local admin must never end up owning a guide they cannot edit.
 * Returns whether it is actually gone: on false the blob persists WITHOUT
 * delegation (visible under deny-list semantics, editable by nobody but
 * global admins) and the caller must say so instead of claiming a rollback
 * that did not happen.
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
    await deleteGuide(createAgentAccessBlobStorage(), id, etag);
    auditAdminWrite('guide-delete', canonicalKey, userMail);
    return true;
  } catch (error) {
    console.error(
      `[agent-access-admin] ROLLBACK DELETE FAILED — guide id=${sanitizeForLog(id)} key=${sanitizeForLog(canonicalKey)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
    );
    return false;
  }
}

function conflictResponse(service: AgentAccessService) {
  // Another replica just won the CAS — refresh this replica's cached state
  // promptly instead of serving it stale for ≤60s.
  service.invalidate();
  return errorResponse(
    'Guide was modified by another admin; reload and retry',
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
    let stored: StoredGuide[] = [];
    let config: AgentAccessConfig | null = null;
    let guidesUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllGuides(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      // Same contract as the rules listing: storage outage → empty listing
      // flagged guidesUnavailable, not a 500.
      console.error(
        `[agent-access-admin] direct guides read failed: ${sanitizeForLog(error)}`,
      );
      guidesUnavailable = true;
      // The direct read exists for CAS-fresh etags, not authorization: when it
      // fails, authorize from the service's ≤60s-stale last-known-good config
      // so local admins receive the same degraded 200 as global admins instead
      // of a false 403. A cold replica with no snapshot still fails closed.
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
      guides: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        guide: entry.guide,
        etag: entry.etag,
      })),
      guidesUnavailable,
      fetchedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list guides');
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
  const parsed = guideFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid guide body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }
  const fieldError = validateGuideFields(parsed.data);
  if (fieldError) {
    return badRequestResponse(fieldError);
  }

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    // Any admin may create — including a local admin with zero delegated keys
    // (the created guide is auto-delegated to them below).
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    // Server-generated immutable id; the canonical key and blob path hang off
    // it, so renames never orphan rules or delegations.
    const id = `guide-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(GUIDE_SOURCE, id);
    const now = new Date().toISOString();
    const guide: Guide = {
      version: 1,
      id,
      kind: parsed.data.kind,
      name: parsed.data.name,
      description: parsed.data.description,
      languages: parsed.data.languages,
      ...payloadFieldsOf(parsed.data),
      workflows: normalizeWorkflows(parsed.data.workflows),
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    // writeGuide derives the blob path from the record's own id, so the key
    // audited/delegated below is exactly the key being written.
    const etag = await writeGuide(createAgentAccessBlobStorage(), guide, null);
    service.invalidate();
    auditAdminWrite('guide-upsert', canonicalKey, userMail);

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
          // Record it in the durable audit trail (creation history was not yet
          // written) and tell the client exactly what needs cleanup — never
          // claim a rollback that did not happen.
          await appendHistoryBestEffort({
            version: 1,
            canonicalKey,
            action: 'upsert',
            guide,
            updatedBy: userMail,
            updatedAt: now,
          });
          return errorResponse(
            `Could not record delegation AND rollback failed: guide ${id} still exists without delegation and needs global-admin cleanup`,
            503,
          );
        }
        return errorResponse(
          'Could not record delegation; guide creation rolled back',
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
      guide,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({ guide, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to create guide');
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
  const parsed = parsePutBody(body);
  if (!parsed.success) {
    return badRequestResponse('Invalid guide body', parsed.issues);
  }
  const fieldError = validateGuideFields(parsed.fields);
  if (fieldError) {
    return badRequestResponse(fieldError);
  }

  if (!GUIDE_ID_PATTERN.test(parsed.id)) {
    return badRequestResponse('id is not a valid guide id');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(GUIDE_SOURCE, parsed.id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this guide key');
    }

    // Updates are keyed on the body id — ids are immutable and
    // server-generated, so a PUT can never mint a new record.
    const existing = await readGuide(createAgentAccessBlobStorage(), parsed.id);
    if (existing === null) {
      return notFoundResponse('Guide');
    }

    // The kind is part of the record's identity: access-rule preambles,
    // slot eligibility, and the payload shape all hang off it. Changing it
    // in place would orphan the old payload — delete and recreate instead.
    if (parsed.fields.kind !== existing.guide.kind) {
      return badRequestResponse('kind cannot be changed');
    }

    const now = new Date().toISOString();
    // Constructed explicitly — NEVER spread over existing.guide: the
    // permissive read schema would keep any stale cross-kind payload fields
    // forever. Only id/createdBy/createdAt survive from the stored record.
    const guide: Guide = {
      version: 1,
      id: existing.guide.id,
      kind: existing.guide.kind,
      name: parsed.fields.name,
      description: parsed.fields.description,
      languages: parsed.fields.languages,
      ...payloadFieldsOf(parsed.fields),
      workflows: normalizeWorkflows(parsed.fields.workflows),
      createdBy: existing.guide.createdBy,
      createdAt: existing.guide.createdAt,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeGuide(
      createAgentAccessBlobStorage(),
      guide,
      ifMatchEtag,
    );
    service.invalidate();
    auditAdminWrite('guide-upsert', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      guide,
      updatedBy: userMail,
      updatedAt: now,
    });

    return successResponse({ guide, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to update guide');
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
  if (!GUIDE_ID_PATTERN.test(id.trim())) {
    return badRequestResponse('id is not a valid guide id');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(GUIDE_SOURCE, id);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(userMail, service.getSnapshot().config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this guide key');
    }

    // Delegation keys referencing this guide are left dangling in config
    // (render as unknown keys in the admin UI) — documented and acceptable,
    // matching prompt-agent and connector deletes.
    const deleted = await deleteGuide(
      createAgentAccessBlobStorage(),
      id.trim(),
      ifMatchEtag,
    );
    if (!deleted) {
      return notFoundResponse('Guide');
    }
    service.invalidate();
    auditAdminWrite('guide-delete', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      guide: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });

    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      return conflictResponse(service);
    }
    return handleApiError(error, 'Failed to delete guide');
  }
}
