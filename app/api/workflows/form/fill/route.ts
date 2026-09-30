import { NextRequest } from 'next/server';

import { collectCallerFills } from '@/lib/services/workflows/form/fillRequest';
import {
  RawFillResponse,
  buildFillSchema,
  normalizeFillResponse,
} from '@/lib/services/workflows/form/fillSchema';
import {
  FillSourceInput,
  buildFillSystemPrompt,
  buildFillUserPrompt,
} from '@/lib/services/workflows/form/prompts';
import { fieldStatus, isLocked } from '@/lib/services/workflows/form/status';
import { parseTemplate } from '@/lib/services/workflows/form/templateSchema';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
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
import { markdownToProse } from '@/lib/utils/shared/markdown/markdownToProse';

import {
  FORM_LIMITS,
  FieldFill,
  FillSourceRecord,
  FormDocument,
  QuestionMode,
} from '@/types/formFill';

import { auth } from '@/auth';

export const maxDuration = 300;

/** Per-source token budget; keeps many sources from crowding the prompt. */
const SOURCE_TOKEN_BUDGET = 12_000;
const MAX_TARGETS = 60;
const MAX_NOTES = 40;

interface FillRequest {
  template: unknown;
  language: string;
  /** Current fills — confirmed/locked ones are sent as context. */
  fields: Record<string, FieldFill>;
  targetFieldIds: string[];
  sources: Array<{ record: FillSourceRecord; text: string }>;
  notes: Array<{ id: string; text: string }>;
  mode: QuestionMode;
  modelId?: string;
  conversationId?: string;
}

/**
 * POST /api/workflows/form/fill — proposes values for the target fields from
 * the supplied material. Synchronous JSON (one strict json_schema call);
 * proposals are reviewed client-side before anything enters the ledger.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('form-fill'))) {
    return workflowDisabledResponse('form-fill');
  }

  let body: FillRequest;
  try {
    body = (await req.json()) as FillRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = parseTemplate(body.template);
  if (!parsed.ok)
    return badRequestResponse(`Invalid template: ${parsed.error}`);
  const template = parsed.template;

  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim().slice(0, 60)
      : 'English';
  const mode: QuestionMode = body.mode === 'general' ? 'general' : 'targeted';

  // Pre-flight the token budget BEFORE any per-field work (validators run
  // on the caller's values), so an over-budget caller costs nothing.
  const { denied, usage } = await beginWorkflowRun(
    session,
    'form_fill',
    body.conversationId,
  );
  if (denied) return denied;

  const byId = new Map(template.fields.map((f) => [f.id, f]));
  // Caller-keyed writes are allow-listed against the template's field ids
  // (CodeQL alert 466) — never copy request object keys verbatim.
  const fills = collectCallerFills(body.fields, new Set(byId.keys()));
  if (!Array.isArray(body.targetFieldIds) || body.targetFieldIds.length === 0) {
    return badRequestResponse('targetFieldIds is required');
  }
  const targets = [...new Set(body.targetFieldIds)]
    .map((id) => byId.get(id))
    .filter((f): f is NonNullable<typeof f> => !!f)
    // Never re-fill what the user settled or an admin locked.
    .filter((f) => {
      if (isLocked(f)) return false;
      const { status } = fieldStatus(f, fills[f.id]);
      return status !== 'confirmed' && status !== 'not_applicable';
    })
    .slice(0, MAX_TARGETS);
  if (targets.length === 0) {
    return badRequestResponse('No fillable target fields', 'NO_TARGETS');
  }

  const rawSources = Array.isArray(body.sources) ? body.sources : [];
  if (rawSources.length > FORM_LIMITS.MAX_SOURCES_PER_FILL) {
    return badRequestResponse('Too many sources');
  }
  const notes = (Array.isArray(body.notes) ? body.notes : [])
    .filter(
      (n) =>
        n &&
        typeof n.id === 'string' &&
        typeof n.text === 'string' &&
        n.text.trim(),
    )
    .slice(0, MAX_NOTES)
    .map((n) => ({
      id: n.id,
      text: n.text.slice(0, FORM_LIMITS.MAX_NOTE_CHARS),
    }));

  try {
    const sources: FillSourceInput[] = [];
    for (const source of rawSources) {
      if (
        !source?.record ||
        typeof source.record.id !== 'string' ||
        typeof source.record.name !== 'string' ||
        typeof source.text !== 'string' ||
        !source.text.trim()
      ) {
        continue;
      }
      // Prose, whatever the client sent: excerpts are verified against and
      // shown from this text, and a Markdown escape is not on the page.
      const budgeted = await truncateToTokenBudget(
        markdownToProse(source.text),
        SOURCE_TOKEN_BUDGET,
      );
      sources.push({
        record: {
          id: source.record.id,
          kind: source.record.kind,
          name: source.record.name.slice(0, 300),
          url:
            typeof source.record.url === 'string'
              ? source.record.url
              : undefined,
          language:
            typeof source.record.language === 'string'
              ? source.record.language
              : undefined,
          chars: budgeted.text.length,
          addedAt: String(source.record.addedAt ?? ''),
        },
        text: budgeted.text,
      });
    }
    const knownSourceIds = new Set<string>([
      ...sources.map((s) => s.record.id),
      ...notes.map((n) => n.id),
    ]);

    const document: FormDocument = {
      id: 'request',
      template,
      language,
      fields: fills,
      questions: [],
      runs: [],
      proposals: [],
    };
    const confirmed = template.fields
      .filter((f) => {
        const fill = fills[f.id];
        if (!fill) return false;
        const { status } = fieldStatus(f, fill);
        return status === 'confirmed';
      })
      .map((field) => ({ field, fill: fills[field.id] }));

    const client = createAzureClient();
    const raw = await callStructured<RawFillResponse>({
      client,
      model: resolveWorkflowModelId(body.modelId),
      system: buildFillSystemPrompt({ language, mode }),
      user: buildFillUserPrompt({
        document,
        targets,
        sources,
        notes,
        confirmed,
      }),
      schemaName: 'form_fill',
      schema: buildFillSchema(targets, mode),
      usage,
      usageLabel: 'fill',
    });
    // Verified against exactly what the model was shown (the budgeted
    // text), so an excerpt from beyond the budget can never be "found".
    const sourceTexts = new Map<string, string>([
      ...sources.map((s): [string, string] => [s.record.id, s.text]),
      ...notes.map((n): [string, string] => [n.id, n.text]),
    ]);
    const { proposals, questions } = normalizeFillResponse(
      raw,
      targets,
      knownSourceIds,
      sourceTexts,
    );
    return successResponse({
      proposals,
      questions,
      targetFieldIds: targets.map((f) => f.id),
      sourceIds: sources.map((s) => s.record.id),
      ...usage.fields(),
    });
  } catch (error) {
    console.error(`[workflows/form/fill] Failed: ${sanitizeForLog(error)}`);
    return handleApiError(error, 'Fill failed');
  }
}
