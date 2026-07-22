import { NextRequest } from 'next/server';

import {
  buildDataChatSystemPrompt,
  buildDataChatUserPrompt,
  buildDataDigest,
} from '@/lib/services/workflows/data/chatPrompts';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStreamedText,
  createAzureClient,
  createWorkflowStream,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';

import {
  badRequestResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { ColumnProfile, DataColumn } from '@/types/workflow';

import { auth } from '@/auth';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';

export const maxDuration = 300;

const DIGEST_TOKEN_BUDGET = 20_000;
const MAX_SAMPLE_ROWS = 300;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_000;

interface DataChatRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  columns: DataColumn[];
  /** Sample rows WITH their __rid values. */
  sampleRows: Record<string, unknown>[];
  /** Deterministic stats over the FULL table. */
  stats: ColumnProfile[];
  totalRowCount: number;
  modelId?: string;
}

/**
 * POST /api/workflows/data/chat — the data workspace's conversation
 * rail. Streams a grounded answer over the table digest (schema + exact
 * client-computed stats + sample rows). Read-only: no mutation sentinel;
 * the workspace transform bar is the single write path.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: DataChatRequest;
  try {
    body = (await req.json()) as DataChatRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequestResponse('Messages are required');
  }
  if (!Array.isArray(body.columns) || body.columns.length === 0) {
    return badRequestResponse('Columns are required');
  }
  if (!Array.isArray(body.sampleRows)) {
    return badRequestResponse('Rows are required');
  }
  if (body.sampleRows.length > MAX_SAMPLE_ROWS) {
    return badRequestResponse('Too many sample rows');
  }

  const messages = body.messages
    .filter(
      (m) =>
        (m?.role === 'user' || m?.role === 'assistant') &&
        typeof m.content === 'string',
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }));

  const model = resolveWorkflowModelId(body.modelId);
  const { stream, writer } = createWorkflowStream();

  void (async () => {
    try {
      const digest = (
        await truncateToTokenBudget(
          buildDataDigest({
            columns: body.columns,
            stats: Array.isArray(body.stats) ? body.stats : [],
            sampleRows: body.sampleRows,
            totalRowCount:
              typeof body.totalRowCount === 'number'
                ? body.totalRowCount
                : body.sampleRows.length,
          }),
          DIGEST_TOKEN_BUDGET,
        )
      ).text;

      const client = createAzureClient();
      await callStreamedText({
        client,
        model,
        system: buildDataChatSystemPrompt(),
        user: buildDataChatUserPrompt(digest, messages),
        onDelta: (delta) => writer.text(delta),
        signal: req.signal,
      });
      writer.close();
    } catch (error) {
      console.error('[workflows/data/chat] Failed:', error);
      writer.fail(
        'data-analysis',
        error instanceof Error ? error.message : 'Data chat failed',
      );
    }
  })();

  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
