import { NextRequest } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { resolveFolderAccess } from '@/lib/services/analytics/access';
import {
  AnalyticsTrendPoint,
  AnalyticsTrendResponse,
} from '@/lib/services/analytics/dto';
import { effectiveHiddenFields } from '@/lib/services/analytics/fields';
import { isSafeRelativePath } from '@/lib/services/analytics/paths';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import { TREND_DATASETS } from '@/lib/services/analytics/rollup';
import { viewRollup } from '@/lib/services/analytics/rollupModel';
import { loadRollup } from '@/lib/services/analytics/tableSource';
import { selectTrendFiles } from '@/lib/services/analytics/trend';

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
 * GET /api/analytics/trend?folder=<path> — the reports under a folder as a
 * series over time: each one's headline figures and the one or two
 * breakdowns its report type plots across periods.
 *
 * Every point goes through the same per-person filter as a dashboard, with
 * its OWN folder's access and hidden fields — a restricted sub-folder
 * contributes nothing to a trend drawn from its parent.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const folder = request.nextUrl.searchParams.get('folder');
  if (folder === null) return badRequestResponse('folder is required');
  if (!isSafeRelativePath(folder)) {
    return badRequestResponse('folder is not a valid folder path');
  }

  try {
    const context = await loadAnalyticsContext(request, session);
    const access = resolveFolderAccess(folder, context.folders, context.actor);
    if (access === 'none') return notFoundResponse('Folder');
    if (context.data.policyUnavailable && access !== 'admin') {
      return errorResponse(
        'Dashboards are unavailable right now',
        503,
        undefined,
        'ANALYTICS_POLICY_UNAVAILABLE',
      );
    }

    const selection = selectTrendFiles(
      folder,
      context.files,
      context.folders,
      context.actor,
    );
    if (selection.status !== 'ok' || selection.reportType === null) {
      const body: AnalyticsTrendResponse = {
        reportType: selection.reportType,
        status: selection.status,
        points: [],
      };
      return successResponse(body);
    }

    const service = AnalyticsService.getInstance();
    const only = TREND_DATASETS[selection.reportType];
    const loaded = await Promise.all(
      selection.files.map(async ({ file, access: fileAccess }) => {
        const rollup = await loadRollup(service, file);
        if (rollup === null || file.period === null) return null;
        const point: AnalyticsTrendPoint = {
          ...viewRollup(
            rollup,
            {
              access: fileAccess,
              hidden: effectiveHiddenFields(
                file.folder,
                context.folders,
                context.data.policy,
              ),
            },
            only,
          ),
          file: { id: file.id, name: file.name },
          period: file.period,
        };
        return point;
      }),
    );
    const points = loaded.filter(
      (point): point is AnalyticsTrendPoint => point !== null,
    );
    const body: AnalyticsTrendResponse = {
      reportType: selection.reportType,
      status: points.length >= 2 ? 'ok' : 'none',
      points,
    };
    return successResponse(body);
  } catch (error) {
    return handleApiError(error, 'Failed to load the trend');
  }
}
