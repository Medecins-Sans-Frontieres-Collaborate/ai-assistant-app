import { NextRequest } from 'next/server';

import {
  createAgentAccessBlobStorage,
  readFormTemplate,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  applyLockedValues,
  prefillUserFromSession,
} from '@/lib/services/workflows/form/adminValues';
import { isDocx } from '@/lib/services/workflows/form/docxFill';
import {
  DocxTextFill,
  fillDocxDocument,
} from '@/lib/services/workflows/form/docxTextAnchors';
import {
  canUseAdminTemplate,
  parseOriginalRef,
  readOriginalFile,
} from '@/lib/services/workflows/form/originalFile';
import { fillPdfFields, isPdf } from '@/lib/services/workflows/form/pdfFill';
import { parseTemplate } from '@/lib/services/workflows/form/templateSchema';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';

import {
  badRequestResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { FORM_LIMITS } from '@/types/formFill';

import { auth } from '@/auth';

export const maxDuration = 60;

interface RenderRequest {
  template: unknown;
  /** Values keyed by FIELD id (the route maps them to anchors). */
  values: Record<string, string | boolean>;
  flatten?: boolean;
}

/**
 * POST /api/workflows/form/render — fills the template's original file in
 * place (DOCX content controls or PDF AcroForm) with the given values and
 * returns the bytes base64-encoded with a per-field report. No model call.
 * The original is read from the caller's own upload namespace only.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('form-fill'))) {
    return workflowDisabledResponse('form-fill');
  }

  let body: RenderRequest;
  try {
    body = (await req.json()) as RenderRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = parseTemplate(body.template);
  if (!parsed.ok)
    return badRequestResponse(`Invalid template: ${parsed.error}`);
  const template = parsed.template;
  if (!template.original || template.original.fillMode === 'none') {
    return badRequestResponse(
      'This template cannot be filled in place',
      'NOT_FILLABLE',
    );
  }
  if (!body.values || typeof body.values !== 'object') {
    return badRequestResponse('values is required');
  }

  // Field id → value, with locked admin fields overridden from the ADMIN
  // copy of the template. Keyed on the ORIGINAL's reference, not on the
  // client's envelope: whoever fills an admin-owned file gets that
  // template's locks, whatever origin/id the snapshot claims (a "copy to
  // mine" keeps the admin original and therefore its locks).
  let values: Record<string, string | boolean> = body.values;
  const originalRef = parseOriginalRef(template.original.fileId);
  if (!originalRef) return badRequestResponse('Invalid original reference');
  if (originalRef.kind === 'admin') {
    if (!(await canUseAdminTemplate(session, originalRef.templateId, req))) {
      return notFoundResponse('Template');
    }
    const stored = await readFormTemplate(
      createAgentAccessBlobStorage(),
      originalRef.templateId,
    );
    const adminParsed = stored ? parseTemplate(stored.record.template) : null;
    if (!adminParsed?.ok) return notFoundResponse('Template');
    values = applyLockedValues(
      adminParsed.template,
      values,
      prefillUserFromSession(session.user),
    );
  }

  // Field id → anchor. Unanchored fields are simply not written.
  const byAnchor: Record<string, string | boolean> = {};
  const textFills: DocxTextFill[] = [];
  for (const field of template.fields) {
    if (!field.anchor) continue;
    const value = values[field.id];
    if (value === undefined || value === null) continue;
    const text =
      typeof value === 'boolean'
        ? value
        : String(value).slice(0, FORM_LIMITS.MAX_VALUE_CHARS);
    switch (field.anchor.kind) {
      case 'docx-control':
        byAnchor[field.anchor.tag] = text;
        break;
      case 'pdf-field':
        byAnchor[field.anchor.fieldName] = text;
        break;
      case 'docx-text':
        textFills.push({
          labelText: field.anchor.labelText,
          occurrence: field.anchor.occurrence,
          placement: field.anchor.placement,
          value: text,
        });
        break;
    }
  }

  try {
    const file = await readOriginalFile(session, template.original.fileId, req);
    if (file.ext === 'docx') {
      if (!isDocx(file.bytes))
        return badRequestResponse('Original is not a DOCX');
      const result = fillDocxDocument(file.bytes, byAnchor, textFills);
      return successResponse({
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ext: 'docx',
        bytes: Buffer.from(result.bytes).toString('base64'),
        filled: result.filled,
        missing: result.missing,
        failed: [],
      });
    }
    if (!isPdf(file.bytes)) return badRequestResponse('Original is not a PDF');
    const result = await fillPdfFields(file.bytes, byAnchor, {
      flatten: body.flatten === true,
    });
    return successResponse({
      mime: 'application/pdf',
      ext: 'pdf',
      bytes: Buffer.from(result.bytes).toString('base64'),
      filled: result.filled,
      missing: result.missing,
      failed: result.failed,
    });
  } catch (error) {
    console.error(`[workflows/form/render] Failed: ${sanitizeForLog(error)}`);
    return handleApiError(error, 'Render failed');
  }
}
