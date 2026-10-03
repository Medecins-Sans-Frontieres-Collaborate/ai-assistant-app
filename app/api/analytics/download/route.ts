import { NextRequest, NextResponse } from 'next/server';

import { AnalyticsService } from '@/lib/services/analytics/AnalyticsService';
import { resolveFolderAccess } from '@/lib/services/analytics/access';
import { auditAnalytics } from '@/lib/services/analytics/audit';
import { extensionOf } from '@/lib/services/analytics/paths';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import {
  canDownloadOriginal,
  isFileVisible,
} from '@/lib/services/analytics/viewModel';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  payloadTooLargeResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const FILE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** The route buffers the file; larger ones need a streamed response. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  parquet: 'application/vnd.apache.parquet',
};

/**
 * GET /api/analytics/download?id=<file id> — the delivered file itself.
 *
 * The id is a hash of a path the app LISTED; no request value reaches a
 * storage path. Served through the app rather than a SAS link so that access
 * is checked at the moment of download and every attempt on a file the caller
 * can see is recorded, allowed or not.
 *
 * A file the caller cannot see answers 404 (no existence oracle). A file they
 * can see but may not download answers 403 with the reason.
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
    const file = context.files.find((candidate) => candidate.id === id);
    if (!file) return notFoundResponse('File');

    const access = resolveFolderAccess(
      file.folder,
      context.folders,
      context.actor,
    );
    if (!isFileVisible(file, access)) return notFoundResponse('File');

    if (!canDownloadOriginal(file, access)) {
      const reason =
        access === 'view' ? 'view-only' : (file.originalBlock ?? 'restricted');
      auditAnalytics(session.user, file.path, 'download', 'deny', reason);
      return errorResponse(
        'This file cannot be downloaded with your access',
        403,
        reason,
        'ANALYTICS_DOWNLOAD_RESTRICTED',
      );
    }
    if (file.size > MAX_DOWNLOAD_BYTES) {
      return payloadTooLargeResponse(
        `${MAX_DOWNLOAD_BYTES / (1024 * 1024)} MB`,
      );
    }

    const content = await AnalyticsService.getInstance()
      .getDeliveryStore()
      .download(file.path);
    if (content === null) return notFoundResponse('File');

    auditAnalytics(session.user, file.path, 'download', 'allow', access);
    return new NextResponse(new Uint8Array(content), {
      headers: {
        'Content-Type':
          CONTENT_TYPES[extensionOf(file.path)] ?? 'application/octet-stream',
        'Content-Length': String(content.length),
        // filename* (RFC 5987) carries non-ASCII names.
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return handleApiError(error, 'Failed to download analytics file');
  }
}
