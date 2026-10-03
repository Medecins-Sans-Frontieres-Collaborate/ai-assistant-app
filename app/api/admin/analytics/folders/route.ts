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
  readFoldersDocument,
  writeFoldersDocument,
} from '@/lib/services/analytics/analyticsStore';
import { AnalyticsFoldersAdminResponse } from '@/lib/services/analytics/dto';
import { scheduleAnalyticsMaintenance } from '@/lib/services/analytics/maintenance';
import { isRawPath } from '@/lib/services/analytics/paths';
import {
  AnalyticsFolder,
  AnalyticsFoldersDocument,
} from '@/lib/services/analytics/types';
import { allFolderPaths } from '@/lib/services/analytics/viewModel';
import { analyticsFoldersPutBodySchema } from '@/lib/services/analytics/writeSchema';

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
 * GET/PUT /api/admin/analytics/folders — the folder overlay: how each folder
 * of the delivery container is presented, who may open it, how long its
 * files are kept.
 *
 * Global admins and delegated analytics admins. Evaluated on the session
 * USER, so an admin "viewing as" a lesser role is refused as that role.
 *
 * RAW IS GLOBAL-ADMIN TERRITORY. A delegated admin never receives the `raw/`
 * entries and cannot change them: on their PUT the stored raw entries are
 * carried over untouched and any they submit are dropped. Nobody can give a
 * raw folder an audience — the access evaluator would ignore it anyway, and
 * storing one would only mislead.
 *
 * CAS: `If-Match` to update, no header to create. On a lost race → 409.
 */

function conflictResponse() {
  return errorResponse(
    'Analytics folders were modified by another admin; reload and retry',
    409,
    undefined,
    'ANALYTICS_FOLDERS_CONFLICT',
  );
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnalyticsAdmin(session.user);
  if (!isAnalyticsAdmin(status)) return forbiddenResponse();

  const service = AnalyticsService.getInstance();
  await service.ensureFresh();
  const snapshot = service.getSnapshot();
  const visible = (path: string) => status.isGlobalAdmin || !isRawPath(path);
  const paths = allFolderPaths({
    folders: snapshot.folders,
    policy: snapshot.policy,
    policyUnavailable: snapshot.policyUnavailable,
    state: snapshot.state,
    blobs: snapshot.blobs,
  }).filter(visible);

  try {
    const result = await readFoldersDocument(createAnalyticsAdminStorage());
    const body: AnalyticsFoldersAdminResponse = {
      document: result
        ? {
            ...result.document,
            folders: result.document.folders.filter((folder) =>
              visible(folder.path),
            ),
          }
        : null,
      etag: result?.etag ?? null,
      unavailable: false,
      isGlobalAdmin: status.isGlobalAdmin,
      paths,
    };
    return successResponse(body);
  } catch (error) {
    // Never answer "no folders configured" on a read failure: the admin would
    // rebuild from an empty overlay and overwrite the real one.
    console.error(
      `[analytics-admin] folders read failed: ${sanitizeForLog(error)}`,
    );
    const body: AnalyticsFoldersAdminResponse = {
      document: null,
      etag: null,
      unavailable: true,
      isGlobalAdmin: status.isGlobalAdmin,
      paths,
    };
    return successResponse(body);
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const { status } = await resolveAnalyticsAdmin(session.user);
  if (!isAnalyticsAdmin(status)) return forbiddenResponse();
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = analyticsFoldersPutBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid analytics folders',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const submitted = parsed.data.folders;
  const duplicate = submitted
    .map((folder) => folder.path)
    .find((path, index, all) => all.indexOf(path) !== index);
  if (duplicate !== undefined) {
    return badRequestResponse('Duplicate folder path', duplicate || '(root)');
  }
  for (const folder of submitted) {
    const raw = isRawPath(folder.path);
    if (raw && folder.audience.length > 0) {
      return badRequestResponse(
        'Raw folders cannot have an audience',
        folder.path,
      );
    }
    if (
      (folder.reportType === 'raw-telemetry') !== raw &&
      folder.reportType !== null
    ) {
      return badRequestResponse(
        raw
          ? 'Raw folders can only hold raw telemetry'
          : 'Raw telemetry can only be delivered under raw/',
        folder.path,
      );
    }
  }

  try {
    const storage = createAnalyticsAdminStorage();
    const stored = await readFoldersDocument(storage);
    if ((stored?.etag ?? null) !== ifMatchEtag) return conflictResponse();

    // A delegated admin's submission never carries (and never changes) raw.
    const folders: AnalyticsFolder[] = status.isGlobalAdmin
      ? submitted.map((folder) =>
          isRawPath(folder.path) ? { ...folder, hiddenFields: [] } : folder,
        )
      : [
          ...submitted.filter((folder) => !isRawPath(folder.path)),
          ...(stored?.document.folders ?? []).filter((folder) =>
            isRawPath(folder.path),
          ),
        ];

    const now = new Date().toISOString();
    const document: AnalyticsFoldersDocument = {
      ...(stored?.document ?? {}),
      version: 1,
      folders,
      updatedBy: userMail,
      updatedAt: now,
    };
    const etag = await writeFoldersDocument(storage, document, ifMatchEtag);
    console.log(
      `[analytics-admin] action=upsert-folders folders=${folders.length} by=${sanitizeForLog(userMail)}`,
    );
    // This replica served the write; others converge within their 60 s TTL.
    const service = AnalyticsService.getInstance();
    service.invalidateConfig();
    // A changed report type re-validates the files under it.
    scheduleAnalyticsMaintenance({ force: true });

    const responseDocument: AnalyticsFoldersDocument = status.isGlobalAdmin
      ? document
      : {
          ...document,
          folders: folders.filter((folder) => !isRawPath(folder.path)),
        };
    return successResponse({ document: responseDocument, etag });
  } catch (error) {
    if (error instanceof AnalyticsConflictError) return conflictResponse();
    return handleApiError(error, 'Failed to write analytics folders');
  }
}
