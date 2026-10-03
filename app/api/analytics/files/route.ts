import { NextRequest } from 'next/server';

import { resolveFolderAccess } from '@/lib/services/analytics/access';
import {
  AnalyticsFileDto,
  AnalyticsFilesResponse,
} from '@/lib/services/analytics/dto';
import { isSafeRelativePath } from '@/lib/services/analytics/paths';
import { loadAnalyticsContext } from '@/lib/services/analytics/requestContext';
import {
  canDownloadOriginal,
  canExport,
  canPreview,
  canViewDashboard,
  isFileVisible,
} from '@/lib/services/analytics/viewModel';

import {
  badRequestResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

/**
 * GET /api/analytics/files?folder=<path> — the files directly in one folder.
 *
 * `folder` is only ever COMPARED with the folder of files the app listed; it
 * is never joined into a storage path. A folder the caller may not open
 * answers the same 404 as one that does not exist.
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const folder = request.nextUrl.searchParams.get('folder');
  if (folder === null) return badRequestResponse('folder is required');
  // Never reaches storage either way, but a path with `..` or empty segments
  // names no folder and would resolve its access through string surgery.
  if (!isSafeRelativePath(folder)) {
    return badRequestResponse('folder is not a valid folder path');
  }

  try {
    const context = await loadAnalyticsContext(request, session);
    const access = resolveFolderAccess(folder, context.folders, context.actor);
    if (access === 'none') return notFoundResponse('Folder');

    const files: AnalyticsFileDto[] = context.files
      .filter((file) => file.folder === folder && isFileVisible(file, access))
      .sort(
        (a, b) =>
          (b.period?.to ?? '').localeCompare(a.period?.to ?? '') ||
          a.name.localeCompare(b.name),
      )
      .map((file) => {
        const canDownload = canDownloadOriginal(file, access);
        return {
          id: file.id,
          name: file.name,
          size: file.size,
          period: file.period,
          deliveredAt: file.lastModified,
          expiresAt: file.expiresAt,
          canDownload,
          downloadBlock: canDownload
            ? null
            : access === 'view'
              ? 'view-only'
              : file.originalBlock,
          canPreview: canPreview(file, access),
          canExport: canExport(file, access),
          canViewDashboard: canViewDashboard(file, access),
          ...(access === 'admin'
            ? {
                admin: {
                  validation: file.validation,
                  expired: file.expired,
                  issues: file.issues,
                  originalBlock: file.originalBlock,
                },
              }
            : {}),
        };
      });

    const body: AnalyticsFilesResponse = { folder, access, files };
    return successResponse(body);
  } catch (error) {
    return handleApiError(error, 'Failed to load analytics files');
  }
}
