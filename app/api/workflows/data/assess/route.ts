import { NextRequest } from 'next/server';

import { buildDataAssessmentSchema } from '@/lib/services/workflows/data/assessSchema';
import {
  buildDataAssessmentSystemPrompt,
  buildDataAssessmentUserPrompt,
} from '@/lib/services/workflows/data/prompts';
import {
  MAX_ASSESS_ROWS,
  getRowId,
} from '@/lib/services/workflows/data/tableUtils';
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
import { DATA_QUALITY_CRITERIA } from '@/lib/utils/shared/data/qualityCriteria';

import { ColumnProfile, DataColumn } from '@/types/workflow';

import { auth } from '@/auth';

export const maxDuration = 300;

const MAX_EDITS = 100;

interface DataAssessRequest {
  columns: DataColumn[];
  /** Scoped (possibly sampled) rows, WITH their __rid values. */
  rows: Record<string, unknown>[];
  /** Deterministic stats over the FULL table (prompt ground truth). */
  stats: ColumnProfile[];
  criteria: string[];
  scope: 'table' | 'filtered' | 'selection' | 'ingest';
  sampled: boolean;
  totalRowCount: number;
  modelId?: string;
}

interface DataAssessLlmResponse {
  criteria: Array<{ criterionId: string; rating: number; summary: string }>;
  edits: Array<{
    criterion: string;
    kind: 'cell' | 'deleteRow';
    rid: string;
    columnId: string;
    before: string;
    after: string;
    reason: string;
    severity: 'minor' | 'major';
  }>;
  overallSummary: string;
}

/**
 * POST /api/workflows/data/assess — criterion-based data-quality
 * assessment producing cell-level fixes anchored by stable row id.
 * Sync JSON, mirroring document/assess. Edits referencing unknown rows
 * or columns are dropped here, so the client only ever reviews
 * applicable proposals.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  // Admin workflow policy (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md): a workflow an
  // admin switched off is refused server-side, not just hidden.
  if (!(await isWorkflowEnabled('data-analysis'))) {
    return workflowDisabledResponse('data-analysis');
  }

  let body: DataAssessRequest;
  try {
    body = (await req.json()) as DataAssessRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return badRequestResponse('Columns are required');
  }
  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return badRequestResponse('Rows are required');
  }
  if (body.rows.length > MAX_ASSESS_ROWS) {
    return badRequestResponse(
      `Assessment is limited to ${MAX_ASSESS_ROWS} rows — sample before sending`,
      'ROW_CAP_EXCEEDED',
    );
  }
  if (!Array.isArray(body.criteria) || body.criteria.length === 0) {
    return badRequestResponse('criteria must be a non-empty array');
  }
  const criterionIds = [...new Set(body.criteria)];
  const known = new Set<string>(DATA_QUALITY_CRITERIA.map((c) => c.id));
  if (criterionIds.some((id) => !known.has(id))) {
    return badRequestResponse('Unknown criterion');
  }
  const stats = Array.isArray(body.stats) ? body.stats : [];

  try {
    const rubrics = DATA_QUALITY_CRITERIA.filter((c) =>
      criterionIds.includes(c.id),
    ).map((c) => c.promptDescription);

    const client = createAzureClient();
    const result = await callStructured<DataAssessLlmResponse>({
      client,
      model: resolveWorkflowModelId(body.modelId),
      system: buildDataAssessmentSystemPrompt(rubrics),
      user: buildDataAssessmentUserPrompt({
        columns: body.columns,
        rows: body.rows,
        stats,
        totalRowCount:
          typeof body.totalRowCount === 'number'
            ? body.totalRowCount
            : body.rows.length,
        sampled: body.sampled === true,
      }),
      schemaName: 'data_quality_assessment',
      schema: buildDataAssessmentSchema(criterionIds),
    });

    // Drop edits that don't anchor to a sent row / real column.
    const sentRids = new Set(
      body.rows.map((row) => getRowId(row)).filter(Boolean),
    );
    const columnIds = new Set(body.columns.map((c) => c.id));
    const edits = result.edits
      .filter((edit) => {
        if (!sentRids.has(edit.rid)) return false;
        if (edit.kind === 'cell') return columnIds.has(edit.columnId);
        return true;
      })
      .slice(0, MAX_EDITS);

    return successResponse({
      criteria: result.criteria,
      edits,
      overallSummary: result.overallSummary,
    });
  } catch (error) {
    console.error('[workflows/data/assess] Failed:', error);
    return handleApiError(error, 'Assessment failed');
  }
}
