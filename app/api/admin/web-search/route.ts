import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { WebSearchConfigService } from '@/lib/services/webSearch/config/WebSearchConfigService';
import {
  isAllowedAssessorModel,
  listAssessorModels,
} from '@/lib/services/webSearch/config/assessorModels';
import {
  ASSESSOR_FALLBACK_MODEL_ID,
  MULTI_STEP_BOUNDS,
  MULTI_STEP_DEFAULTS,
  MultiStepSettingsWriteSchema,
  WebSearchConfig,
} from '@/lib/services/webSearch/config/types';
import {
  WebSearchConfigConflictError,
  createWebSearchConfigBlobStorage,
  readWebSearchConfig,
  writeWebSearchConfig,
  writeWebSearchConfigHistory,
} from '@/lib/services/webSearch/config/webSearchConfigStore';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * GET/PUT /api/admin/web-search — the org-wide web search configuration
 * (docs/WEB_SEARCH_MULTI_STEP.md).
 *
 * GLOBAL admins only: one org-wide document, so there is no subset a local
 * admin could own. The check takes the session USER (not the bare mail), so
 * an admin currently "viewing as" a regular user is refused here too.
 *
 * CAS: If-Match update / absent If-Match create-only, 412 → 409. GET reads
 * storage directly so the echoed ETag is current for editing, and carries
 * the code defaults, bounds and assessor choices so the panel never
 * duplicates them.
 */

const putBodySchema = z.object({
  multiStep: MultiStepSettingsWriteSchema,
});

const reference = () => ({
  defaults: MULTI_STEP_DEFAULTS,
  bounds: MULTI_STEP_BOUNDS,
  assessorModels: listAssessorModels(),
  assessorFallbackModelId: ASSESSOR_FALLBACK_MODEL_ID,
});

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    const result = await readWebSearchConfig(
      createWebSearchConfigBlobStorage(),
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
      `[web-search-admin] config read failed: ${sanitizeForLog(error)}`,
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
      'Invalid web search configuration',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  const { multiStep } = parsed.data;
  if (
    multiStep.assessorModelId !== undefined &&
    !isAllowedAssessorModel(multiStep.assessorModelId)
  ) {
    return badRequestResponse(
      'Invalid web search configuration',
      'multiStep.assessorModelId: not a model that can assess searches',
    );
  }
  if (
    multiStep.maxSteps !== undefined &&
    multiStep.maxStepsExploratory !== undefined &&
    multiStep.maxStepsExploratory < multiStep.maxSteps
  ) {
    return badRequestResponse(
      'Invalid web search configuration',
      'multiStep.maxStepsExploratory: must not be lower than maxSteps',
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const now = new Date().toISOString();
  const config: WebSearchConfig = {
    version: 1,
    multiStep,
    updatedBy: userMail,
    updatedAt: now,
  };

  try {
    const storage = createWebSearchConfigBlobStorage();
    const etag = await writeWebSearchConfig(storage, config, ifMatchEtag);
    const summary = Object.entries(multiStep)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(',');
    console.log(
      `[web-search-admin] action=upsert ${sanitizeForLog(summary || 'defaults')} by=${sanitizeForLog(userMail)}`,
    );
    await writeWebSearchConfigHistory(storage, {
      version: 1,
      config,
      updatedBy: userMail,
      updatedAt: now,
    });
    WebSearchConfigService.getInstance().invalidate();
    return successResponse({ config, etag });
  } catch (error) {
    if (error instanceof WebSearchConfigConflictError) {
      return errorResponse(
        'Web search configuration was modified by another admin; reload and retry',
        409,
        undefined,
        'WEB_SEARCH_CONFIG_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to write web search configuration');
  }
}
