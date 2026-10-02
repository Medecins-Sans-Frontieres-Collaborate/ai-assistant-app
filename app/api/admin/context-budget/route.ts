import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { ContextBudgetService } from '@/lib/services/contextBudget/ContextBudgetService';
import {
  ContextBudgetConfigConflictError,
  createContextBudgetConfigBlobStorage,
  readContextBudgetConfig,
  writeContextBudgetConfig,
  writeContextBudgetConfigHistory,
} from '@/lib/services/contextBudget/contextBudgetStore';
import {
  CONTEXT_BUDGET_BOUNDS,
  CONTEXT_BUDGET_DEFAULTS,
  ContextBudgetConfig,
  ContextBudgetSettingsWriteSchema,
} from '@/lib/services/contextBudget/types';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { OpenAIModels } from '@/types/openai';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * GET/PUT /api/admin/context-budget — how much conversation history each
 * model is sent (lib/services/contextBudget/types.ts).
 *
 * GLOBAL admins only: one org-wide document, so there is no subset a local
 * admin could own. The check takes the session USER (not the bare mail), so
 * an admin currently "viewing as" a regular user is refused here too.
 *
 * CAS: If-Match update / absent If-Match create-only, 412 → 409. GET reads
 * storage directly so the echoed ETag is current for editing, and carries
 * the code defaults, bounds and the catalog's families and models so the
 * panel never duplicates them.
 */

const putBodySchema = z.object({
  budget: ContextBudgetSettingsWriteSchema,
});

/** Families and models an override may name, with their windows. */
function catalogReference() {
  const families = new Map<string, string>();
  const models: Array<{
    id: string;
    name: string;
    series?: string;
    maxLength: number;
    tokenLimit: number;
  }> = [];
  for (const model of Object.values(OpenAIModels)) {
    if (model.isDisabled) continue;
    if (model.series && !families.has(model.series)) {
      families.set(model.series, model.seriesLabel ?? model.series);
    }
    models.push({
      id: model.id,
      name: model.name,
      series: model.series,
      maxLength: model.maxLength,
      tokenLimit: model.tokenLimit,
    });
  }
  return {
    families: [...families].map(([id, label]) => ({ id, label })),
    models,
  };
}

const reference = () => ({
  defaults: CONTEXT_BUDGET_DEFAULTS,
  bounds: CONTEXT_BUDGET_BOUNDS,
  ...catalogReference(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    const result = await readContextBudgetConfig(
      createContextBudgetConfigBlobStorage(),
    );
    return successResponse({
      config: result?.config ?? null,
      etag: result?.etag ?? null,
      configUnavailable: false,
      ...reference(),
    });
  } catch (error) {
    // Never answer "no config" on a read failure: the admin would see the
    // defaults while the running service may be serving something else.
    console.error(
      `[context-budget-admin] config read failed: ${sanitizeForLog(error)}`,
    );
    return successResponse({
      config: null,
      etag: null,
      configUnavailable: true,
      ...reference(),
    });
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid context budget configuration',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  const { budget } = parsed.data;

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const now = new Date().toISOString();
  const config: ContextBudgetConfig = {
    version: 1,
    budget,
    updatedBy: userMail,
    updatedAt: now,
  };

  try {
    const storage = createContextBudgetConfigBlobStorage();
    const etag = await writeContextBudgetConfig(storage, config, ifMatchEtag);
    const summary = Object.entries(budget)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(',');
    console.log(
      `[context-budget-admin] action=upsert ${sanitizeForLog(summary || 'defaults')} by=${sanitizeForLog(userMail)}`,
    );
    await writeContextBudgetConfigHistory(storage, {
      version: 1,
      config,
      updatedBy: userMail,
      updatedAt: now,
    });
    ContextBudgetService.getInstance().invalidate();
    return successResponse({ config, etag });
  } catch (error) {
    if (error instanceof ContextBudgetConfigConflictError) {
      return errorResponse(
        'Context budget configuration was modified by another admin; reload and retry',
        409,
        undefined,
        'CONTEXT_BUDGET_CONFIG_CONFLICT',
      );
    }
    return handleApiError(
      error,
      'Failed to write context budget configuration',
    );
  }
}
