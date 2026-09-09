import { NextRequest } from 'next/server';

import { PhotoInferResult } from '@/lib/services/workflows/data/photoIngest';
import { photoInferResponseSchema } from '@/lib/services/workflows/data/photoSchema';
import {
  buildPhotoExtractSystemPrompt,
  buildPhotoExtractUserPrompt,
  buildPhotoInferSystemPrompt,
  buildPhotoInferUserPrompt,
} from '@/lib/services/workflows/data/prompts';
import { extractionResponseSchema } from '@/lib/services/workflows/data/tableSchema';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveVisionWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

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

import { DataColumn, DataColumnType } from '@/types/workflow';

import { auth } from '@/auth';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

export const maxDuration = 300;

/** Internal image ref as returned by the upload route. */
const IMAGE_REF_RE = /^\/api\/file\/([0-9a-f]{64}\.[a-zA-Z0-9]{1,4})$/;
const COLUMN_TYPES: readonly DataColumnType[] = [
  'text',
  'number',
  'date',
  'boolean',
];

interface DataPhotoRequest {
  /** Internal '/api/file/{sha256}.{ext}' refs from the image upload. */
  imageRefs: string[];
  /** 'infer' proposes structure + values; 'extract' fills a fixed schema. */
  mode: 'infer' | 'extract';
  /** Target schema for extract mode. */
  columns?: DataColumn[];
  instructions?: string;
  modelId?: string;
}

function isValidColumn(value: unknown): value is DataColumn {
  if (!value || typeof value !== 'object') return false;
  const column = value as Partial<DataColumn>;
  return (
    typeof column.id === 'string' &&
    // Same id format the extract route enforces — ids become json_schema
    // property keys, so keep them to a plain token.
    /^[a-z0-9_]{1,40}$/.test(column.id) &&
    typeof column.name === 'string' &&
    COLUMN_TYPES.includes(column.type as DataColumnType)
  );
}

/**
 * POST /api/workflows/data/photo — structured data from photographed
 * forms/tables (vision call). Sync JSON, mirrors extract. The client
 * uploads images first (user-namespaced blob bucket) and sends only the
 * internal refs; ownership is enforced by the namespaced blob path.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  // Admin workflow policy (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md): a workflow an
  // admin switched off is refused server-side, not just hidden.
  if (!(await isWorkflowEnabled('data-analysis'))) {
    return workflowDisabledResponse('data-analysis');
  }

  let body: DataPhotoRequest;
  try {
    body = (await req.json()) as DataPhotoRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  if (!Array.isArray(body.imageRefs) || body.imageRefs.length === 0) {
    return badRequestResponse('imageRefs is required');
  }
  if (body.imageRefs.length > FILE_COUNT_LIMITS.MAX_IMAGES) {
    return badRequestResponse(
      `At most ${FILE_COUNT_LIMITS.MAX_IMAGES} photos per extraction`,
      'IMAGE_CAP_EXCEEDED',
    );
  }
  const blobIds: string[] = [];
  for (const ref of body.imageRefs) {
    const match = typeof ref === 'string' ? ref.match(IMAGE_REF_RE) : null;
    if (!match) return badRequestResponse('Invalid image reference');
    blobIds.push(match[1]);
  }

  if (body.mode !== 'infer' && body.mode !== 'extract') {
    return badRequestResponse('mode must be "infer" or "extract"');
  }
  if (body.mode === 'extract') {
    if (
      !Array.isArray(body.columns) ||
      body.columns.length === 0 ||
      !body.columns.every(isValidColumn)
    ) {
      return badRequestResponse('Valid columns are required for extract mode');
    }
  }
  const instructions =
    typeof body.instructions === 'string'
      ? body.instructions.slice(0, 2_000)
      : undefined;

  try {
    const userId = getUserIdFromSession(session);
    const imageParts: ChatCompletionContentPart[] = [];
    for (const blobId of blobIds) {
      const dataUrl = await getBlobBase64String(
        userId,
        blobId,
        'images',
        session.user,
      );
      // Re-check size cheaply: base64 is ~4/3 of the byte size.
      if (dataUrl.length > FILE_SIZE_LIMITS.IMAGE_MAX_BYTES * 1.4) {
        return badRequestResponse('Image is too large', 'IMAGE_TOO_LARGE');
      }
      imageParts.push({
        type: 'image_url',
        image_url: { url: dataUrl, detail: 'high' },
      });
    }

    const client = createAzureClient();
    const model = resolveVisionWorkflowModelId(body.modelId);

    if (body.mode === 'infer') {
      const result = await callStructured<PhotoInferResult>({
        client,
        model,
        system: buildPhotoInferSystemPrompt(),
        user: [
          { type: 'text', text: buildPhotoInferUserPrompt(instructions) },
          ...imageParts,
        ],
        schemaName: 'photo_infer',
        schema: photoInferResponseSchema(),
      });
      return successResponse(result);
    }

    const columns = body.columns as DataColumn[];
    const result = await callStructured<{
      rows: Record<string, unknown>[];
    }>({
      client,
      model,
      system: buildPhotoExtractSystemPrompt(),
      user: [
        {
          type: 'text',
          text: buildPhotoExtractUserPrompt(columns, instructions),
        },
        ...imageParts,
      ],
      schemaName: 'photo_extract',
      schema: extractionResponseSchema(columns),
    });
    return successResponse({ rows: result.rows });
  } catch (error) {
    console.error('[workflows/data/photo] Failed:', sanitizeForLog(error));
    return handleApiError(error, 'Photo extraction failed');
  }
}
