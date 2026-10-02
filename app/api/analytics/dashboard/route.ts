import { NextRequest } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { auditAnalytics } from '@/lib/services/analytics/audit';
import { AnalyticsDashboardResponse } from '@/lib/services/analytics/dto';
import {
  FILE_ID_PATTERN,
  resolveVisibleFile,
} from '@/lib/services/analytics/previewRequest';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import { viewRollup } from '@/lib/services/analytics/rollupModel';
import { loadRollup } from '@/lib/services/analytics/tableSource';
import { canViewDashboard } from '@/lib/services/analytics/viewModel';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/analytics/dashboard?id=<file id> — the aggregates a file's
 * dashboard is drawn from, as this person may see them.
 *
 * Open at `view` level: this is what view access is FOR. The server removes
 * any breakdown by a hidden field and, at view level, folds groups of fewer
 * than five people into one unnamed row before answering — the per-person
 * rows the aggregates were computed from never leave it.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const id = request.nextUrl.searchParams.get('id');
  if (!id || !FILE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid file id');
  }

  try {
    const context = await loadAnalyticsContext(request, session);
    const resolved = resolveVisibleFile(context, id);
    if (!resolved || !canViewDashboard(resolved.file, resolved.access)) {
      return notFoundResponse('Dashboard');
    }
    // Without the field policy nobody can say which breakdowns are hidden.
    if (context.data.policyUnavailable && resolved.access !== 'admin') {
      return errorResponse(
        'Dashboards are unavailable right now',
        503,
        undefined,
        'ANALYTICS_POLICY_UNAVAILABLE',
      );
    }

    const rollup = await loadRollup(
      AnalyticsService.getInstance(),
      resolved.file,
    );
    if (rollup === null) return notFoundResponse('Dashboard');

    auditAnalytics(
      session.user,
      resolved.file.path,
      'view',
      'allow',
      `${resolved.access}:dashboard`,
    );
    const body: AnalyticsDashboardResponse = {
      ...viewRollup(rollup, resolved.preview),
      file: { id: resolved.file.id, name: resolved.file.name },
      period: resolved.file.period,
      access: resolved.access,
    };
    return successResponse(body);
  } catch (error) {
    return handleApiError(error, 'Failed to load the dashboard');
  }
}
