import { NextRequest } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { AnalyticsPreviewResponse } from '@/lib/services/analytics/dto';
import { summarizeTable } from '@/lib/services/analytics/previewModel';
import {
  FILE_ID_PATTERN,
  resolveVisibleFile,
} from '@/lib/services/analytics/previewRequest';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import { loadPreviewTables } from '@/lib/services/analytics/tableSource';
import { PREVIEW_ROWS } from '@/lib/services/analytics/tables';
import { canExport, canPreview } from '@/lib/services/analytics/viewModel';

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
 * GET /api/analytics/preview?id=<file id> — the tables of a file, without
 * their rows: names, sizes, and for each one whether this person may open it.
 *
 * A table they may not open is LISTED with the reason (row-level data needs
 * download access; a page holds a hidden field) rather than left out, so the
 * tab strip explains itself.
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
    if (!resolved || !canPreview(resolved.file, resolved.access)) {
      return notFoundResponse('Preview');
    }
    // Without the field policy nobody can say which columns are hidden:
    // fail closed for everyone it applies to.
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
    if (tables === null) return notFoundResponse('Preview');

    const body: AnalyticsPreviewResponse = {
      file: { id: resolved.file.id, name: resolved.file.name },
      access: resolved.access,
      tables: tables.map((table) => summarizeTable(table, resolved.preview)),
      canExport: canExport(resolved.file, resolved.access),
      previewRows: PREVIEW_ROWS,
    };
    return successResponse(body);
  } catch (error) {
    return handleApiError(error, 'Failed to load the preview');
  }
}
