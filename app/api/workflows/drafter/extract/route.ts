import { NextRequest } from 'next/server';

import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  EXTRACT_SCHEMA,
  ExtractSourceInput,
  RawExtractResponse,
  SOURCE_PRE_SLICE_CHARS,
  SOURCE_TOKEN_BUDGET,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  normalizeExtractResponse,
  parseExistingItems,
  parseExtractSources,
} from '@/lib/services/workflows/shared/drafter/extract';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStructured,
  createAzureClient,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import { getSpecAdapter } from '@/lib/utils/shared/drafter/adapters';

import { DRAFTER_LIMITS, ExtractRequest } from '@/types/drafter';

import { auth } from '@/auth';

export const maxDuration = 300;

/**
 * POST /api/workflows/drafter/extract: proposes brief items from the
 * supplied sources and VERIFIES each against the source text before
 * returning it. Kind-agnostic; `specKind` only selects whose admin policy
 * guards the call.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: ExtractRequest;
  try {
    body = (await req.json()) as ExtractRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const adapter = getSpecAdapter(body.specKind);
  if (!adapter) return badRequestResponse('Unknown specKind');
  if (!(await isWorkflowEnabled(adapter.workflow))) {
    return workflowDisabledResponse(adapter.workflow);
  }

  const rawSources = Array.isArray(body.sources) ? body.sources : [];
  if (rawSources.length === 0) return badRequestResponse('sources is required');
  if (rawSources.length > DRAFTER_LIMITS.MAX_SOURCES) {
    return badRequestResponse('Too many sources');
  }

  const { denied, usage } = await beginWorkflowRun(
    session,
    'drafter_extract',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const sources: ExtractSourceInput[] = [];
    // Ids, names and text arrive already validated and cut by characters,
    // so the tokeniser never sees more than SOURCE_PRE_SLICE_CHARS.
    for (const source of parseExtractSources(rawSources)) {
      // Verification runs against exactly what the model was shown, so an
      // excerpt from beyond the budget can never be "found".
      const budgeted = await truncateToTokenBudget(
        source.text,
        SOURCE_TOKEN_BUDGET,
      );
      const cutByChars =
        !budgeted.truncated && source.text.length >= SOURCE_PRE_SLICE_CHARS;
      sources.push({
        ...source,
        text: cutByChars ? `${budgeted.text}\n\n[…truncated…]` : budgeted.text,
      });
    }
    if (sources.length === 0) {
      return badRequestResponse('No readable source text', 'NO_SOURCE_TEXT');
    }

    const existing = parseExistingItems(body.existing);

    const raw = await callStructured<RawExtractResponse>({
      client: createAzureClient(),
      model: resolveWorkflowModelId(body.modelId),
      system: buildExtractSystemPrompt(),
      user: buildExtractUserPrompt(sources, existing),
      schemaName: 'drafter_extract',
      schema: EXTRACT_SCHEMA,
      usage,
      usageLabel: 'extract',
    });

    return successResponse({
      ...normalizeExtractResponse(raw, sources),
      ...usage.fields(),
    });
  } catch (error) {
    console.error(
      `[workflows/drafter/extract] Failed: ${sanitizeForLog(error)}`,
    );
    return handleApiError(error, 'Extraction failed');
  }
}
