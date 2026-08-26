import { NextRequest } from 'next/server';

import {
  buildTransformSystemPrompt,
  buildTransformUserPrompt,
} from '@/lib/services/workflows/data/prompts';
import { transformResponseSchema } from '@/lib/services/workflows/data/tableSchema';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
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

import { DataColumn, DataColumnType } from '@/types/workflow';

import { auth } from '@/auth';

export const maxDuration = 300;

/** LLM transforms are capped; larger tables should be filtered first. */
const MAX_TRANSFORM_ROWS = 500;

interface DataTransformRequest {
  columns: DataColumn[];
  rows: Record<string, unknown>[];
  instruction: string;
  /** Reserved for the future code-interpreter executor. */
  engine?: 'llm' | 'code';
  /**
   * The rows are a subset of a larger table: the result must keep the
   * same row count/order (cell edits + new columns only) so the client
   * can merge it back positionally.
   */
  scoped?: boolean;
  modelId?: string;
}

interface TransformLlmResponse {
  columns: Array<{ id: string; name: string; type: DataColumnType }>;
  rows: Array<{ values: string[] }>;
  explanation: string;
}

function coerce(value: string, type: DataColumnType): unknown {
  if (value === '') return null;
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isNaN(n) ? null : n;
    }
    case 'boolean':
      return value === 'true' ? true : value === 'false' ? false : null;
    default:
      return value;
  }
}

/**
 * POST /api/workflows/data/transform — LLM table transformation.
 * Synchronous JSON: the result is transactional (the client replaces its
 * table only on a valid response). engine:'code' (Foundry code
 * interpreter) is reserved for v1.1 and rejected explicitly.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  // Admin workflow policy (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md): a workflow an
  // admin switched off is refused server-side, not just hidden.
  if (!(await isWorkflowEnabled('data-analysis'))) {
    return workflowDisabledResponse('data-analysis');
  }

  let body: DataTransformRequest;
  try {
    body = (await req.json()) as DataTransformRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  if (body.engine === 'code') {
    return badRequestResponse(
      'The code execution engine is not available yet',
      'ENGINE_UNAVAILABLE',
    );
  }
  const instruction = body.instruction?.trim();
  if (!instruction) return badRequestResponse('Instruction is required');
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return badRequestResponse('Columns are required');
  }
  if (!Array.isArray(body.rows)) {
    return badRequestResponse('Rows are required');
  }
  if (body.rows.length > MAX_TRANSFORM_ROWS) {
    return badRequestResponse(
      `Transforms are limited to ${MAX_TRANSFORM_ROWS} rows — filter the table first`,
      'ROW_CAP_EXCEEDED',
    );
  }

  try {
    const client = createAzureClient();
    const result = await callStructured<TransformLlmResponse>({
      client,
      model: resolveWorkflowModelId(body.modelId),
      system: buildTransformSystemPrompt(body.scoped === true),
      user: buildTransformUserPrompt(
        body.columns,
        body.rows,
        instruction.slice(0, 2_000),
      ),
      schemaName: 'data_transform',
      schema: transformResponseSchema(),
    });

    if (body.scoped === true) {
      // Positional merge-back is only sound when the shape held: same
      // row count and no existing column dropped. Reject otherwise —
      // the client keeps its table untouched (transactional).
      const resultIds = new Set(result.columns.map((c) => c.id));
      const dropped = body.columns.some((c) => !resultIds.has(c.id));
      if (result.rows.length !== body.rows.length || dropped) {
        return badRequestResponse(
          'The scoped transform changed the table shape — row-count-changing operations need the full-table scope',
          'SCOPED_SHAPE_MISMATCH',
        );
      }
    }

    // Reshape values-array rows into keyed rows, coercing per column type.
    const columns = result.columns.slice(0, 60);
    const rows = result.rows.map((row) => {
      const out: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        out[column.id] = coerce(row.values[index] ?? '', column.type);
      });
      return out;
    });

    return successResponse({
      columns,
      rows,
      explanation: result.explanation,
    });
  } catch (error) {
    console.error('[workflows/data/transform] Failed:', error);
    return handleApiError(error, 'Transform failed');
  }
}
