import { NextRequest } from 'next/server';

import {
  AnchorReport,
  anchorDocxFields,
  anchorDocxText,
  anchorPdfFields,
} from '@/lib/services/workflows/form/anchors';
import {
  DERIVE_SCHEMA,
  RawDerivedTemplate,
  buildTemplateDraft,
  normalizeDerived,
} from '@/lib/services/workflows/form/deriveSchema';
import {
  detectDocxControls,
  isDocx,
} from '@/lib/services/workflows/form/docxFill';
import { detectDocxTextSlots } from '@/lib/services/workflows/form/docxTextAnchors';
import { readOriginalFile } from '@/lib/services/workflows/form/originalFile';
import { detectPdfFields, isPdf } from '@/lib/services/workflows/form/pdfFill';
import {
  buildDeriveSystemPrompt,
  buildDeriveUserPrompt,
  buildLayoutSystemPrompt,
  buildLayoutUserPrompt,
} from '@/lib/services/workflows/form/prompts';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import {
  resolveVisionWorkflowModelId,
  resolveWorkflowModelId,
} from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import { FILE_COUNT_LIMITS, FILE_SIZE_LIMITS } from '@/lib/utils/app/const';
import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { getBlobBase64String } from '@/lib/utils/server/blob/blob';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { FORM_LIMITS, FormTemplate } from '@/types/formFill';

import { auth } from '@/auth';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

/** Internal image ref as returned by the upload route. */
const IMAGE_REF_RE = /^\/api\/file\/([0-9a-f]{64}\.[a-zA-Z0-9]{1,4})$/;

export const maxDuration = 180;

const TEXT_TOKEN_BUDGET = 60_000;
const MAX_INSTRUCTION_CHARS = 4_000;

interface DeriveRequest {
  sourceKind: 'file' | 'paste' | 'instructions' | 'image';
  /** Internal '/api/file/{sha256}.{ext}' image refs (sourceKind 'image'). */
  imageRefs?: string[];
  /** Extracted/pasted text (required unless sourceKind is 'instructions'). */
  text?: string;
  instructions?: string;
  /** `/api/file/<sha>.<docx|pdf>` — enables the anchor pass. */
  fileId?: string;
  fileName?: string;
  modelId?: string;
  conversationId?: string;
}

/**
 * POST /api/workflows/form/derive — proposes a template (sections, typed
 * fields, validation, language, layout) from an uploaded document, pasted
 * form text, or instructions alone. When the upload is a DOCX/PDF the
 * original is inspected for content controls / AcroForm fields and the
 * fields are anchored to them, so the template knows up front whether it
 * can be filled in place (docs/DOCUMENT_FILL_ASSESSMENT.md §7a).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('form-fill'))) {
    return workflowDisabledResponse('form-fill');
  }

  let body: DeriveRequest;
  try {
    body = (await req.json()) as DeriveRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const sourceKind = body.sourceKind;
  if (!['file', 'paste', 'instructions', 'image'].includes(sourceKind)) {
    return badRequestResponse(
      'sourceKind must be file, paste, instructions or image',
    );
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const instructions =
    typeof body.instructions === 'string'
      ? body.instructions.trim().slice(0, MAX_INSTRUCTION_CHARS)
      : '';
  if (sourceKind === 'instructions' && !instructions) {
    return badRequestResponse('Instructions are required');
  }
  if (sourceKind !== 'instructions' && sourceKind !== 'image' && !text) {
    return badRequestResponse('Document text is required');
  }
  // Screenshot → template (phase 3): the same internal image refs the data
  // workflow's photo route accepts; bytes are read server-side from the
  // caller's own namespace and never leave as anything but a data URL.
  const imageIds: string[] = [];
  if (sourceKind === 'image') {
    const refs = Array.isArray(body.imageRefs) ? body.imageRefs : [];
    if (refs.length === 0 || refs.length > FILE_COUNT_LIMITS.MAX_IMAGES) {
      return badRequestResponse('Between 1 and 10 images are required');
    }
    for (const ref of refs) {
      const match = typeof ref === 'string' ? ref.match(IMAGE_REF_RE) : null;
      if (!match) return badRequestResponse('Invalid image reference');
      imageIds.push(match[1]);
    }
  }

  const { denied, usage } = await beginWorkflowRun(
    session,
    'form_derive',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const budgeted = text
      ? await truncateToTokenBudget(text, TEXT_TOKEN_BUDGET)
      : { text: '', truncated: false };
    const client = createAzureClient();
    const imageParts: ChatCompletionContentPart[] = [];
    if (sourceKind === 'image') {
      const userId = getUserIdFromSession(session);
      for (const blobId of imageIds) {
        const dataUrl = await getBlobBase64String(
          userId,
          blobId,
          'images',
          session.user,
        );
        if (dataUrl.length > FILE_SIZE_LIMITS.IMAGE_MAX_BYTES * 1.4) {
          return badRequestResponse('Image is too large', 'IMAGE_TOO_LARGE');
        }
        imageParts.push({
          type: 'image_url',
          image_url: { url: dataUrl, detail: 'high' },
        });
      }
    }
    const model =
      sourceKind === 'image'
        ? resolveVisionWorkflowModelId(body.modelId)
        : resolveWorkflowModelId(body.modelId);
    const derivePrompt = buildDeriveUserPrompt({
      text: budgeted.text,
      instructions: instructions || undefined,
      sourceKind,
    });

    const raw = await callStructured<RawDerivedTemplate>({
      client,
      model,
      system: buildDeriveSystemPrompt(),
      user:
        imageParts.length > 0
          ? [{ type: 'text', text: derivePrompt }, ...imageParts]
          : derivePrompt,
      schemaName: 'form_template_derive',
      schema: DERIVE_SCHEMA as unknown as Record<string, unknown>,
      usage,
      usageLabel: 'derive',
    });
    const draft = normalizeDerived(raw);
    if (draft.fields.length === 0) {
      return badRequestResponse(
        'No fillable fields were found in this material',
        'NO_FIELDS',
      );
    }

    // Layout from the document's own text, when there is one. A failed or
    // incoherent layout falls back to the structural one (reconcileLayout).
    let layout: string | undefined;
    if (
      sourceKind !== 'instructions' &&
      draft.fields.length <= FORM_LIMITS.MAX_FIELDS
    ) {
      try {
        const layoutPrompt = buildLayoutUserPrompt({
          text: budgeted.text,
          sections: draft.sections,
          fields: draft.fields,
          fromImage: imageParts.length > 0,
        });
        const result = await callStructured<{ layout: string }>({
          client,
          model,
          system: buildLayoutSystemPrompt(),
          user:
            imageParts.length > 0
              ? [{ type: 'text', text: layoutPrompt }, ...imageParts]
              : layoutPrompt,
          schemaName: 'form_template_layout',
          schema: {
            type: 'object',
            properties: { layout: { type: 'string' } },
            required: ['layout'],
            additionalProperties: false,
          },
          usage,
          usageLabel: 'layout',
        });
        layout = result.layout;
      } catch (error) {
        console.warn(
          `[workflows/form/derive] Layout call failed: ${sanitizeForLog(error)}`,
        );
      }
    }

    // Anchor pass over the original, when it is a DOCX/PDF the user owns.
    let original: FormTemplate['original'] | undefined;
    let anchorReport: AnchorReport | undefined;
    let fields = draft.fields;
    if (sourceKind === 'file' && typeof body.fileId === 'string') {
      try {
        const file = await readOriginalFile(session, body.fileId);
        if (file.ext === 'docx' && isDocx(file.bytes)) {
          const controls = detectDocxControls(file.bytes);
          let result = anchorDocxFields(fields, controls);
          // No controls to speak of: fall back to label anchoring, which
          // covers forms built as plain tables and "Label: ____" lines.
          if (result.report.anchoredCount === 0) {
            result = anchorDocxText(fields, detectDocxTextSlots(file.bytes));
          }
          fields = result.fields;
          anchorReport = result.report;
        } else if (file.ext === 'pdf' && isPdf(file.bytes)) {
          const result = anchorPdfFields(
            fields,
            await detectPdfFields(file.bytes),
          );
          fields = result.fields;
          anchorReport = result.report;
        }
        original = {
          fileId: body.fileId,
          name:
            typeof body.fileName === 'string' && body.fileName.trim()
              ? body.fileName.trim().slice(0, 300)
              : `original.${file.ext}`,
          mime: file.ext,
          fillMode: anchorReport?.fillMode ?? 'none',
        };
      } catch (error) {
        // An unreadable original is not fatal: the template still works in
        // rendered mode. The report says so.
        console.warn(
          `[workflows/form/derive] Original inspection failed: ${sanitizeForLog(error)}`,
        );
        anchorReport = {
          fillMode: 'none',
          unmatchedSlots: [],
          unanchoredFieldIds: fields.map((f) => f.id),
          anchoredCount: 0,
        };
      }
    }

    const template = buildTemplateDraft(
      { ...draft, fields },
      { layout, original },
    );
    return successResponse({
      template,
      anchorReport,
      truncatedSource: budgeted.truncated,
      ...usage.fields(),
    });
  } catch (error) {
    console.error(`[workflows/form/derive] Failed: ${sanitizeForLog(error)}`);
    return handleApiError(error, 'Template derivation failed');
  }
}
