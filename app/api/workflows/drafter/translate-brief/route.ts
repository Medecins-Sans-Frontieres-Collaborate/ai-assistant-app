import { NextRequest } from 'next/server';

import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import {
  RawTranslateBriefResponse,
  TRANSLATE_BRIEF_SCHEMA,
  buildTranslateBriefSystemPrompt,
  buildTranslateBriefUserPrompt,
  normalizeTranslateBriefResponse,
} from '@/lib/services/workflows/shared/drafter/translateBrief';
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

import {
  BriefItemKind,
  DRAFTER_LIMITS,
  TranslateBriefRequest,
} from '@/types/drafter';

import { auth } from '@/auth';

export const maxDuration = 300;

const ITEM_KINDS: readonly BriefItemKind[] = [
  'quote',
  'testimony',
  'fact',
  'figure',
  'context',
];

function languageName(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 60)
    : null;
}

/**
 * POST /api/workflows/drafter/translate-brief: translates a brief's key
 * message, call to action and items into another language, so a new draft
 * can be written from it. Kind-agnostic; `specKind` only selects whose admin
 * policy guards the call. Numbers are checked by code after translation.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: TranslateBriefRequest;
  try {
    body = (await req.json()) as TranslateBriefRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const adapter = getSpecAdapter(body.specKind);
  if (!adapter) return badRequestResponse('Unknown specKind');
  if (!(await isWorkflowEnabled(adapter.workflow))) {
    return workflowDisabledResponse(adapter.workflow);
  }

  const sourceLanguage = languageName(body.sourceLanguage);
  const targetLanguage = languageName(body.targetLanguage);
  if (!sourceLanguage || !targetLanguage) {
    return badRequestResponse('sourceLanguage and targetLanguage are required');
  }

  const items = (Array.isArray(body.items) ? body.items : [])
    .filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.text === 'string' &&
        item.text.trim() &&
        (ITEM_KINDS as readonly string[]).includes(item.kind),
    )
    .slice(0, DRAFTER_LIMITS.MAX_BRIEF_ITEMS)
    .map((item) => ({
      id: item.id.slice(0, 40),
      kind: item.kind,
      text: item.text.slice(0, DRAFTER_LIMITS.MAX_ITEM_CHARS),
      role: typeof item.role === 'string' ? item.role.slice(0, 160) : undefined,
    }));
  const keyMessage =
    typeof body.keyMessage === 'string' ? body.keyMessage.slice(0, 600) : '';
  if (items.length === 0 && !keyMessage.trim()) {
    return badRequestResponse('Nothing to translate');
  }
  const request = {
    keyMessage,
    callToAction:
      typeof body.callToAction === 'string'
        ? body.callToAction.slice(0, 300)
        : undefined,
    items,
  };

  const { denied, usage } = await beginWorkflowRun(
    session,
    'drafter_translate_brief',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const raw = await callStructured<RawTranslateBriefResponse>({
      client: createAzureClient(),
      model: resolveWorkflowModelId(body.modelId),
      system: buildTranslateBriefSystemPrompt(sourceLanguage, targetLanguage),
      user: buildTranslateBriefUserPrompt(request),
      schemaName: 'drafter_translate_brief',
      schema: TRANSLATE_BRIEF_SCHEMA,
      usage,
      usageLabel: 'translate-brief',
    });
    return successResponse({
      ...normalizeTranslateBriefResponse(raw, request),
      ...usage.fields(),
    });
  } catch (error) {
    console.error(
      `[workflows/drafter/translate-brief] Failed: ${sanitizeForLog(error)}`,
    );
    return handleApiError(error, 'Translation failed');
  }
}
