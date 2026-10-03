import { NextRequest } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { resolveFolderAccess } from '@/lib/services/analytics/access';
import { updateStateDocument } from '@/lib/services/analytics/analyticsStore';
import { scheduleAnalyticsMaintenance } from '@/lib/services/analytics/maintenance';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';

import {
  badRequestResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { z } from 'zod';

const bodySchema = z
  .object({
    id: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  })
  .strict();

/**
 * POST /api/admin/analytics/recheck — forget what the validator recorded for
 * one file (`{ id }`) or for every file the caller administers (`{}`), and
 * start a validation run. Files reappear as "being checked" and settle within
 * a few seconds; the health view shows the progress.
 *
 * Rarely needed — a replaced file is re-validated on its own — but it is the
 * way to re-run after a storage hiccup left a file unchecked.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return badRequestResponse('Invalid re-check request');

  try {
    const context = await loadAnalyticsContext(request, session);
    if (!context.actor.isAnalyticsAdmin) return forbiddenResponse();

    const administered = context.files.filter(
      (file) =>
        resolveFolderAccess(file.folder, context.folders, context.actor) ===
        'admin',
    );
    const targets = parsed.data.id
      ? administered.filter((file) => file.id === parsed.data.id)
      : administered;
    if (parsed.data.id && targets.length === 0) return notFoundResponse('File');

    const service = AnalyticsService.getInstance();
    await updateStateDocument(
      service.getAdminStorage(),
      (files) => {
        for (const file of targets) delete files[file.id];
      },
      context.now,
    );
    service.invalidateFiles();
    console.log(
      `[analytics-admin] action=recheck files=${targets.length} by=${sanitizeForLog(session.user.mail ?? session.user.id)}`,
    );
    scheduleAnalyticsMaintenance({ force: true });
    return successResponse({ queued: targets.length });
  } catch (error) {
    return handleApiError(error, 'Failed to queue the re-check');
  }
}
