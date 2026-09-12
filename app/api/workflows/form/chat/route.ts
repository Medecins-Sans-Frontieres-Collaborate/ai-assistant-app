import { NextRequest } from 'next/server';

import {
  buildFormChatSystemPrompt,
  buildFormChatUserPrompt,
  buildLedgerDigest,
} from '@/lib/services/workflows/form/chatPrompts';
import { parseTemplate } from '@/lib/services/workflows/form/templateSchema';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { truncateToTokenBudget } from '@/lib/services/workflows/shared/textBudget';
import {
  callStreamedText,
  createAzureClient,
  createWorkflowStream,
} from '@/lib/services/workflows/shared/workflowLlm';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import {
  FieldFill,
  FillSourceRecord,
  FormDocument,
  QuestionRecord,
} from '@/types/formFill';

import { auth } from '@/auth';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';

export const maxDuration = 300;

const DIGEST_TOKEN_BUDGET = 20_000;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 1_000;

interface FormChatRequest {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  template: unknown;
  language: string;
  fields: Record<string, FieldFill>;
  questions: QuestionRecord[];
  sources: FillSourceRecord[];
  modelId?: string;
  conversationId?: string;
}

/**
 * POST /api/workflows/form/chat — the form workspace's conversation rail.
 * Streams an answer grounded in the ledger digest. Read-only: filling goes
 * through the Fill run and the review queue.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('form-fill'))) {
    return workflowDisabledResponse('form-fill');
  }

  let body: FormChatRequest;
  try {
    body = (await req.json()) as FormChatRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return badRequestResponse('Messages are required');
  }
  const parsed = parseTemplate(body.template);
  if (!parsed.ok)
    return badRequestResponse(`Invalid template: ${parsed.error}`);

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

  const { denied, usage } = await beginWorkflowRun(
    session,
    'rail_chat',
    body.conversationId,
  );
  if (denied) return denied;

  const document: FormDocument = {
    id: 'request',
    template: parsed.template,
    language:
      typeof body.language === 'string' && body.language.trim()
        ? body.language.trim().slice(0, 60)
        : 'English',
    fields: body.fields && typeof body.fields === 'object' ? body.fields : {},
    questions: Array.isArray(body.questions) ? body.questions : [],
    runs: [],
    proposals: [],
  };
  const sources = Array.isArray(body.sources) ? body.sources : [];

  const model = resolveWorkflowModelId(body.modelId);
  const { stream, writer } = createWorkflowStream();
  void (async () => {
    try {
      const digest = (
        await truncateToTokenBudget(
          buildLedgerDigest({ document, sources }),
          DIGEST_TOKEN_BUDGET,
        )
      ).text;
      const client = createAzureClient();
      await callStreamedText({
        client,
        model,
        system: buildFormChatSystemPrompt(),
        user: buildFormChatUserPrompt(digest, messages),
        onDelta: (delta) => writer.text(delta),
        signal: req.signal,
        usage,
        usageLabel: 'rail_chat',
      });
      const usagePayload = usage.payload();
      if (usagePayload) {
        writer.event({
          workflow: 'form-fill',
          type: 'usage',
          data: usagePayload,
        });
      }
      writer.close();
    } catch (error) {
      console.error(`[workflows/form/chat] Failed: ${sanitizeForLog(error)}`);
      writer.fail(
        'form-fill',
        error instanceof Error ? error.message : 'Form chat failed',
      );
    }
  })();
  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
