import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredFormTemplate,
  createAgentAccessBlobStorage,
  deleteFormTemplate,
  listAllFormTemplates,
  readConfig,
  readFormTemplate,
  writeFormTemplate,
  writeFormTemplateHistoryEntry,
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
  AdminFormTemplate,
  AdminFormTemplateHistoryEntry,
  AgentAccessConfig,
  FORM_TEMPLATE_ID_PATTERN,
  FORM_TEMPLATE_SOURCE,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import {
  adminOriginalRef,
  deleteAdminOriginals,
  parseOriginalRef,
  readOriginalFile,
  writeAdminOriginalBytes,
} from '@/lib/services/workflows/form/originalFile';
import {
  AdminTemplateBody,
  parseAdminTemplateBody,
} from '@/lib/services/workflows/form/templateSchema';

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

import { FormTemplate } from '@/types/formFill';

import { auth } from '@/auth';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * GET/POST/PUT/DELETE /api/agent-access/form-templates — admin CRUD for
 * admin-curated form-fill templates (docs/FORM_FILL_WORKFLOW.md, phase 2).
 * 404 while the feature is disabled. Any admin (global or local) may
 * create; edits and deletes are authorized per canonical key
 * (`form-template::<id>`), exactly like guides and map datasets.
 *
 * The template payload is validated by the form workflow's own schema
 * (`AdminTemplateBodySchema`), so an admin template is always a valid
 * FormTemplate for the fill/render routes. An `original` upload is COPIED
 * from the admin's own upload namespace into the admin container on save,
 * and its reference rewritten to `admin:<id>.<ext>` — users of the template
 * never read the admin's personal blobs.
 */

const putIdSchema = z
  .object({ id: z.string().trim().min(1).max(100) })
  .passthrough();

function conflictResponse(service: AgentAccessService) {
  service.invalidate();
  return errorResponse(
    'Template was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

async function appendHistoryBestEffort(
  entry: AdminFormTemplateHistoryEntry,
): Promise<void> {
  try {
    await writeFormTemplateHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

async function rollbackCreate(
  id: string,
  etag: string,
  canonicalKey: string,
  userMail: string,
): Promise<boolean> {
  try {
    await deleteFormTemplate(createAgentAccessBlobStorage(), id, etag);
    await deleteAdminOriginals(id);
    auditAdminWrite('form-template-delete', canonicalKey, userMail);
    return true;
  } catch (error) {
    console.error(
      `[agent-access-admin] ROLLBACK DELETE FAILED — form template id=${sanitizeForLog(id)} key=${sanitizeForLog(canonicalKey)} still exists WITHOUT delegation and needs global-admin cleanup: ${sanitizeForLog(error)}`,
    );
    return false;
  }
}

/** Serialized template inside the record, as the workflow consumes it. */
function toFormTemplate(
  id: string,
  body: AdminTemplateBody,
  original: FormTemplate['original'] | undefined,
  createdAt: string,
  updatedAt: string,
): FormTemplate {
  return {
    ...body,
    original,
    id,
    origin: 'admin',
    createdAt,
    updatedAt,
  } as FormTemplate;
}

/**
 * Moves a freshly uploaded original (a `/api/file/...` ref in the admin's
 * namespace) into the admin container. An `admin:` ref for THIS template is
 * kept as-is (an edit that did not change the file). Any other shape is
 * refused: a template must never point at a blob its users cannot read.
 */
async function settleOriginal(
  session: Session,
  id: string,
  original: AdminTemplateBody['original'],
  req: NextRequest,
): Promise<
  | { ok: true; original: FormTemplate['original'] | undefined }
  | { ok: false; error: string }
> {
  if (!original) return { ok: true, original: undefined };
  const ref = parseOriginalRef(original.fileId);
  if (!ref)
    return { ok: false, error: 'original.fileId is not a valid reference' };
  if (ref.kind === 'admin') {
    if (ref.templateId !== id) {
      return {
        ok: false,
        error: 'original.fileId belongs to another template',
      };
    }
    return {
      ok: true,
      // The extension is the truth; a client-sent `mime` must not disagree.
      original: {
        ...original,
        mime: ref.ext,
        fileId: adminOriginalRef(id, ref.ext),
      },
    };
  }
  const file = await readOriginalFile(session, original.fileId, req);
  // A new upload replaces whatever was there, in either extension.
  await deleteAdminOriginals(id);
  await writeAdminOriginalBytes(id, file.ext, file.bytes);
  return {
    ok: true,
    original: {
      ...original,
      mime: file.ext,
      fileId: adminOriginalRef(id, file.ext),
    },
  };
}

export async function GET() {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    let stored: StoredFormTemplate[] = [];
    let config: AgentAccessConfig | null = null;
    let templatesUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listed, configResult] = await Promise.all([
        listAllFormTemplates(storage),
        readConfig(storage),
      ]);
      stored = listed;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      console.error(
        `[agent-access-admin] direct form-templates read failed: ${sanitizeForLog(error)}`,
      );
      templatesUnavailable = true;
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
      templates: visible.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        record: entry.record,
        etag: entry.etag,
      })),
      templatesUnavailable,
      fetchedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list form templates');
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
  const parsed = parseAdminTemplateBody(body);
  if (!parsed.ok)
    return badRequestResponse('Invalid template body', parsed.error);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const id = `formtpl-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(FORM_TEMPLATE_SOURCE, id);
    const now = new Date().toISOString();

    const settled = await settleOriginal(
      session,
      id,
      parsed.body.original,
      request,
    );
    if (!settled.ok) return badRequestResponse(settled.error);

    const template = toFormTemplate(
      id,
      parsed.body,
      settled.original,
      now,
      now,
    );
    const record: AdminFormTemplate = {
      version: 1,
      id,
      name: template.name,
      description: template.description ?? '',
      template: template as unknown as Record<string, unknown>,
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    };

    const etag = await writeFormTemplate(
      createAgentAccessBlobStorage(),
      record,
      null,
    );
    service.invalidate();
    auditAdminWrite('form-template-upsert', canonicalKey, userMail);

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
            record,
            updatedBy: userMail,
            updatedAt: now,
          });
          return errorResponse(
            `Could not record delegation AND rollback failed: form template ${id} still exists without delegation and needs global-admin cleanup`,
            503,
          );
        }
        return errorResponse(
          'Could not record delegation; template creation rolled back',
          503,
        );
      }
      service.invalidate();
    }

    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      record,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ record, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return conflictResponse(service);
    return handleApiError(error, 'Failed to create form template');
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
  const idParsed = putIdSchema.safeParse(body);
  if (!idParsed.success)
    return badRequestResponse('Invalid template body', 'id');
  const { id, ...rest } = idParsed.data;
  if (!FORM_TEMPLATE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid form template id');
  }
  const parsed = parseAdminTemplateBody(rest);
  if (!parsed.ok)
    return badRequestResponse('Invalid template body', parsed.error);

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }
  const canonicalKey = canonicalAgentKey(FORM_TEMPLATE_SOURCE, id);

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
      return forbiddenResponse('Not authorized for this template key');
    }
    const existing = await readFormTemplate(createAgentAccessBlobStorage(), id);
    if (existing === null) return notFoundResponse('Template');

    const settled = await settleOriginal(
      session,
      id,
      parsed.body.original,
      request,
    );
    if (!settled.ok) return badRequestResponse(settled.error);

    const now = new Date().toISOString();
    const template = toFormTemplate(
      id,
      parsed.body,
      settled.original,
      existing.record.createdAt,
      now,
    );
    const record: AdminFormTemplate = {
      version: 1,
      id,
      name: template.name,
      description: template.description ?? '',
      template: template as unknown as Record<string, unknown>,
      createdBy: existing.record.createdBy,
      createdAt: existing.record.createdAt,
      updatedBy: userMail,
      updatedAt: now,
    };
    const etag = await writeFormTemplate(
      createAgentAccessBlobStorage(),
      record,
      ifMatchEtag,
    );
    service.invalidate();
    auditAdminWrite('form-template-upsert', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      record,
      updatedBy: userMail,
      updatedAt: now,
    });
    return successResponse({ record, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return conflictResponse(service);
    return handleApiError(error, 'Failed to update form template');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const id = request.nextUrl.searchParams.get('id')?.trim();
  if (!id) return badRequestResponse('id query param is required');
  if (!FORM_TEMPLATE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid form template id');
  }
  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }
  const canonicalKey = canonicalAgentKey(FORM_TEMPLATE_SOURCE, id);

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
      return forbiddenResponse('Not authorized for this template key');
    }
    const deleted = await deleteFormTemplate(
      createAgentAccessBlobStorage(),
      id,
      ifMatchEtag,
    );
    if (!deleted) return notFoundResponse('Template');
    try {
      await deleteAdminOriginals(id);
    } catch (error) {
      // Orphaned binary, not a broken template: log and carry on. It is
      // unreadable anyway — canUseAdminTemplate requires a live record.
      console.error(
        `[agent-access-admin] original cleanup failed for ${sanitizeForLog(id)}: ${sanitizeForLog(error)}`,
      );
    }
    service.invalidate();
    auditAdminWrite('form-template-delete', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      record: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });
    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return conflictResponse(service);
    return handleApiError(error, 'Failed to delete form template');
  }
}
