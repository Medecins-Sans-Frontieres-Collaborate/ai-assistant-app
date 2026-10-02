import { NextRequest } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { auditAnalytics } from '@/lib/services/analytics/audit';
import { viewTable } from '@/lib/services/analytics/previewModel';
import {
  FILE_ID_PATTERN,
  resolveVisibleFile,
} from '@/lib/services/analytics/previewRequest';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import { loadPreviewTables } from '@/lib/services/analytics/tableSource';
import { canPreview } from '@/lib/services/analytics/viewModel';

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
 * GET /api/analytics/table?id=<file id>&table=<name> — one table's rows, as
 * this person may see them: hidden and unclassified columns are removed HERE,
 * on the server, before the response is built. The stored preview holds every
 * column; nothing a person may not see is ever sent and then hidden in the
 * browser.
 *
 * `table` is only ever compared with the names of the file's own tables.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const id = request.nextUrl.searchParams.get('id');
  const tableName = request.nextUrl.searchParams.get('table');
  if (!id || !FILE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid file id');
  }
  if (tableName === null) return badRequestResponse('table is required');

  try {
    const context = await loadAnalyticsContext(request, session);
    const resolved = resolveVisibleFile(context, id);
    if (!resolved || !canPreview(resolved.file, resolved.access)) {
      return notFoundResponse('Table');
    }
    if (context.data.policyUnavailable && resolved.access !== 'admin') {
      return errorResponse(
        'Previews are unavailable right now',
        503,
        undefined,
        'ANALYTICS_POLICY_UNAVAILABLE',
      );
    }

    const tables = await loadPreviewTables(
      AnalyticsService.getInstance(),
      resolved.file,
    );
    const table = tables?.find((candidate) => candidate.name === tableName);
    if (!table) return notFoundResponse('Table');

    const view = viewTable(table, resolved.preview);
    if (view === null) {
      auditAnalytics(
        session.user,
        resolved.file.path,
        'view',
        'deny',
        `${resolved.access}:${tableName}`,
      );
      return errorResponse(
        'This table cannot be opened with your access',
        403,
        undefined,
        'ANALYTICS_TABLE_WITHHELD',
      );
    }
    auditAnalytics(
      session.user,
      resolved.file.path,
      'view',
      'allow',
      `${resolved.access}:${tableName}`,
    );
    return successResponse(view);
  } catch (error) {
    return handleApiError(error, 'Failed to load the table');
  }
}
