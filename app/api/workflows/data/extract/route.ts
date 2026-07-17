import { NextRequest } from 'next/server';

import {
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
} from '@/lib/services/workflows/data/prompts';
import { extractionResponseSchema } from '@/lib/services/workflows/data/tableSchema';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { DataColumn } from '@/types/workflow';

import { auth } from '@/auth';

export const maxDuration = 120;

const SOURCE_TOKEN_BUDGET = 60_000;
const MAX_COLUMNS = 60;

interface DataExtractRequest {
  sourceText: string;
  columns: DataColumn[];
  instructions?: string;
  modelId?: string;
}

function isValidColumn(value: unknown): value is DataColumn {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    /^[a-z0-9_]{1,40}$/.test(c.id) &&
    typeof c.name === 'string' &&
    (c.type === 'text' ||
      c.type === 'number' ||
      c.type === 'date' ||
      c.type === 'boolean')
  );
}

/**
 * POST /api/workflows/data/extract — structured extraction of rows
 * matching the current table schema from unstructured material.
 * Synchronous JSON (single strict json_schema call).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: DataExtractRequest;
  try {
    body = (await req.json()) as DataExtractRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  const sourceText = body.sourceText?.trim();
  if (!sourceText) return badRequestResponse('Source text is required');
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return badRequestResponse('Target columns are required');
  }
  if (body.columns.length > MAX_COLUMNS) {
    return badRequestResponse('Too many columns');
  }
  const columns = body.columns.filter(isValidColumn);
  if (columns.length !== body.columns.length) {
    return badRequestResponse('Invalid column definition');
  }

  try {
    const budgeted = await truncateToTokenBudget(
      sourceText,
      SOURCE_TOKEN_BUDGET,
    );
    const client = createAzureClient();
    const result = await callStructured<{ rows: Record<string, unknown>[] }>({
      client,
      model: resolveWorkflowModelId(body.modelId),
      system: buildExtractionSystemPrompt(),
      user: buildExtractionUserPrompt(
        budgeted.text,
        columns,
        typeof body.instructions === 'string'
          ? body.instructions.slice(0, 2_000)
          : undefined,
      ),
      schemaName: 'data_extraction',
      schema: extractionResponseSchema(columns),
    });

    return successResponse({
      rows: result.rows,
      truncatedSource: budgeted.truncated,
    });
  } catch (error) {
    console.error('[workflows/data/extract] Failed:', error);
    return handleApiError(error, 'Extraction failed');
  }
}
