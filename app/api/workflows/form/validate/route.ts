import { NextRequest } from 'next/server';

import {
  RawValidateResponse,
  buildValidateSchema,
} from '@/lib/services/workflows/form/fillSchema';
import {
  buildValidateSystemPrompt,
  buildValidateUserPrompt,
} from '@/lib/services/workflows/form/prompts';
import { fieldStatus } from '@/lib/services/workflows/form/status';
import { parseTemplate } from '@/lib/services/workflows/form/templateSchema';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
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

import {
  DocumentRuleResult,
  FORM_LIMITS,
  FieldFill,
  FormDocument,
} from '@/types/formFill';

import { auth } from '@/auth';

export const maxDuration = 180;

interface ValidateRequest {
  template: unknown;
  language: string;
  fields: Record<string, FieldFill>;
  modelId?: string;
  conversationId?: string;
}

/**
 * POST /api/workflows/form/validate — the model-judged half of validation:
 * each filled field with a `rubric` gets an ok/note verdict, and each
 * template-level rule is checked against the whole set of values. One
 * strict call; nothing is rewritten. Deterministic validators stay
 * client-side (docs/FORM_FILL_WORKFLOW.md).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowEnabled('form-fill'))) {
    return workflowDisabledResponse('form-fill');
  }

  let body: ValidateRequest;
  try {
    body = (await req.json()) as ValidateRequest;
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = parseTemplate(body.template);
  if (!parsed.ok)
    return badRequestResponse(`Invalid template: ${parsed.error}`);
  const template = parsed.template;
  const fills =
    body.fields && typeof body.fields === 'object' ? body.fields : {};
  const language =
    typeof body.language === 'string' && body.language.trim()
      ? body.language.trim().slice(0, 60)
      : 'English';

  // Only filled fields with a rubric are worth a verdict.
  const checkable = template.fields.filter((f) => {
    if (!f.validation?.rubric) return false;
    const { status } = fieldStatus(f, fills[f.id]);
    return status !== 'empty' && status !== 'not_applicable';
  });
  const rules = (template.rules ?? [])
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, FORM_LIMITS.MAX_RULES);
  if (checkable.length === 0 && rules.length === 0) {
    return badRequestResponse('Nothing to validate', 'NOTHING_TO_VALIDATE');
  }

  const { denied, usage } = await beginWorkflowRun(
    session,
    'form_validate',
    body.conversationId,
  );
  if (denied) return denied;

  try {
    const document: FormDocument = {
      id: 'request',
      template,
      language,
      fields: fills,
      questions: [],
      runs: [],
      proposals: [],
    };
    const client = createAzureClient();
    const raw = await callStructured<RawValidateResponse>({
      client,
      model: resolveWorkflowModelId(body.modelId),
      system: buildValidateSystemPrompt(language),
      user: buildValidateUserPrompt({ document, fields: checkable, rules }),
      schemaName: 'form_validate',
      schema: buildValidateSchema(
        checkable.map((f) => f.id),
        rules.length,
      ),
      usage,
      usageLabel: 'validate',
    });
    const fields: Record<string, { ok: boolean; note: string }> = {};
    for (const field of checkable) {
      const verdict = raw.fields?.[field.id];
      if (!verdict) continue;
      fields[field.id] = {
        ok: verdict.ok === true,
        note: String(verdict.note ?? '').slice(0, 600),
      };
    }
    const ruleResults: DocumentRuleResult[] = rules.map((rule, i) => ({
      rule,
      ok: raw.rules?.[i]?.ok === true,
      note: String(raw.rules?.[i]?.note ?? '').slice(0, 600),
    }));
    return successResponse({ fields, rules: ruleResults, ...usage.fields() });
  } catch (error) {
    console.error(`[workflows/form/validate] Failed: ${sanitizeForLog(error)}`);
    return handleApiError(error, 'Validation failed');
  }
}
