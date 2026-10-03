import { NextRequest } from 'next/server';

import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import {
  isAnalyticsAdmin,
  resolveAnalyticsAdmin,
} from '@/lib/services/analytics/adminAccess';
import {
  AnalyticsConflictError,
  createAnalyticsAdminStorage,
  readFieldPolicyDocument,
  writeFieldPolicyDocument,
} from '@/lib/services/analytics/analyticsStore';
import { AnalyticsFieldPolicyAdminResponse } from '@/lib/services/analytics/dto';
import { classifyColumn } from '@/lib/services/analytics/fields';
import { AnalyticsFieldPolicyDocument } from '@/lib/services/analytics/types';
import { analyticsFieldPolicyPutBodySchema } from '@/lib/services/analytics/writeSchema';

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

/**
 * GET/PUT /api/admin/analytics/field-policy — which fields of the delivered
 * reports the platform may show.
 *
 * Reading is open to every analytics admin (they see its effect on their
 * folders). WRITING is global admins only: this is a platform-wide privacy
 * setting, and a delegated admin can only tighten it per folder.
 *
 * Takes effect on the next request — nothing is regenerated. Hidden fields
 * are a property of what is SERVED, not of what was validated.
 */

function conflictResponse() {
  return errorResponse(
    'The field policy was modified by another admin; reload and retry',
    409,
    undefined,
    'ANALYTICS_FIELD_POLICY_CONFLICT',
  );
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnalyticsAdmin(session.user);
  if (!isAnalyticsAdmin(status)) return forbiddenResponse();

  try {
    const result = await readFieldPolicyDocument(createAnalyticsAdminStorage());
    const body: AnalyticsFieldPolicyAdminResponse = {
      document: result?.document ?? null,
      etag: result?.etag ?? null,
      unavailable: false,
      canEdit: status.isGlobalAdmin,
    };
    return successResponse(body);
  } catch (error) {
    console.error(
      `[analytics-admin] field policy read failed: ${sanitizeForLog(error)}`,
    );
    const body: AnalyticsFieldPolicyAdminResponse = {
      document: null,
      etag: null,
      unavailable: true,
      canEdit: status.isGlobalAdmin,
    };
    return successResponse(body);
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnalyticsAdmin(session.user);
  if (!status.isGlobalAdmin) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = analyticsFieldPolicyPutBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid field policy',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  // Columns the built-in catalog already understands are not stored: the
  // catalog wins on read, so a stored mapping for one would be dead weight
  // that reads as if it had an effect.
  const columns = Object.fromEntries(
    Object.entries(parsed.data.columns).filter(
      ([column]) => classifyColumn(column, null) === null,
    ),
  );

  try {
    const storage = createAnalyticsAdminStorage();
    const stored = await readFieldPolicyDocument(storage);
    if ((stored?.etag ?? null) !== ifMatchEtag) return conflictResponse();

    const now = new Date().toISOString();
    const document: AnalyticsFieldPolicyDocument = {
      ...(stored?.document ?? {}),
      version: 1,
      hidden: parsed.data.hidden,
      columns,
      updatedBy: userMail,
      updatedAt: now,
    };
    const etag = await writeFieldPolicyDocument(storage, document, ifMatchEtag);
    console.log(
      `[analytics-admin] action=upsert-field-policy hidden=${sanitizeForLog(parsed.data.hidden.join(',') || 'none')} classified=${Object.keys(columns).length} by=${sanitizeForLog(userMail)}`,
    );
    AnalyticsService.getInstance().invalidateConfig();
    return successResponse({ document, etag });
  } catch (error) {
    if (error instanceof AnalyticsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to write the field policy');
  }
}
