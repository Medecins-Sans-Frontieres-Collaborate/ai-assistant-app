import { NextRequest, NextResponse } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { auditAnalytics } from '@/lib/services/analytics/audit';
import {
  ExportTooLargeError,
  exportFileName,
  tableToCsv,
  tablesToXlsx,
} from '@/lib/services/analytics/exportFile';
import { AnalyticsBusyError } from '@/lib/services/analytics/heavyWork';
import { TableView, viewTable } from '@/lib/services/analytics/previewModel';
import {
  FILE_ID_PATTERN,
  resolveVisibleFile,
} from '@/lib/services/analytics/previewRequest';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import { loadFullTables } from '@/lib/services/analytics/tableSource';
import { canExport } from '@/lib/services/analytics/viewModel';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  payloadTooLargeResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/** Largest delivered file an export will re-read. */
const MAX_EXPORT_SOURCE_BYTES = 200 * 1024 * 1024;

const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

/**
 * GET /api/analytics/export?id=<file id>&format=csv&table=<name>
 * GET /api/analytics/export?id=<file id>&format=xlsx
 *
 * A file the app BUILDS from the delivered report: one table as CSV, or every
 * table the caller may see as a workbook, with hidden and unclassified
 * columns removed. This is what a non-admin receives when the delivered file
 * itself is withheld because it contains a hidden field.
 *
 * Needs `download` access — an export is row-level data. It re-reads the
 * delivered bytes in full (the stored preview is capped), one at a time per
 * replica; when several are already waiting it answers 503 rather than
 * queueing more memory-heavy work.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const params = request.nextUrl.searchParams;
  const id = params.get('id');
  const format = params.get('format');
  const tableName = params.get('table');
  if (!id || !FILE_ID_PATTERN.test(id)) {
    return badRequestResponse('id is not a valid file id');
  }
  if (format !== 'csv' && format !== 'xlsx') {
    return badRequestResponse('format must be csv or xlsx');
  }
  if (format === 'csv' && tableName === null) {
    return badRequestResponse('table is required for a CSV export');
  }

  try {
    const context = await loadAnalyticsContext(request, session);
    const resolved = resolveVisibleFile(context, id);
    if (!resolved) return notFoundResponse('File');
    const { file, access, preview } = resolved;

    const detail = `${format}${tableName ? `:${tableName}` : ''}`;
    if (!canExport(file, access)) {
      auditAnalytics(session.user, file.path, 'export', 'deny', detail);
      return errorResponse(
        'This file cannot be exported with your access',
        403,
        access === 'view' ? 'view-only' : undefined,
        'ANALYTICS_EXPORT_RESTRICTED',
      );
    }
    if (file.size > MAX_EXPORT_SOURCE_BYTES) {
      return payloadTooLargeResponse(
        `${MAX_EXPORT_SOURCE_BYTES / (1024 * 1024)} MB`,
      );
    }

    const tables = await loadFullTables(
      AnalyticsService.getInstance(),
      file,
      context.folders,
      format === 'csv' ? (tableName ?? undefined) : undefined,
    );
    if (tables === null) return notFoundResponse('File');

    const views = tables
      .map((table) => viewTable(table, preview))
      .filter((view): view is TableView => view !== null);

    let content: Buffer;
    if (format === 'csv') {
      const view = views.find((candidate) => candidate.name === tableName);
      if (!view) return notFoundResponse('Table');
      content = tableToCsv(view);
    } else {
      if (views.length === 0) return notFoundResponse('Table');
      content = tablesToXlsx(views);
    }

    auditAnalytics(session.user, file.path, 'export', 'allow', detail);
    const filename = exportFileName(
      file.name,
      format,
      format === 'csv' ? (tableName ?? undefined) : undefined,
    );
    return new NextResponse(new Uint8Array(content), {
      headers: {
        'Content-Type': CONTENT_TYPES[format],
        'Content-Length': String(content.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof AnalyticsBusyError) {
      return NextResponse.json(
        { error: error.message, code: 'ANALYTICS_BUSY' },
        { status: 503, headers: { 'Retry-After': '20' } },
      );
    }
    if (error instanceof ExportTooLargeError) {
      return errorResponse(
        error.message,
        413,
        `${error.cells} cells`,
        'ANALYTICS_EXPORT_TOO_LARGE',
      );
    }
    return handleApiError(error, 'Failed to export the file');
  }
}
