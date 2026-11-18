import { NextRequest, NextResponse } from 'next/server';

import {
  openNativeRunStore,
  parseRunLocation,
  runFileContentType,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import { runStorageErrorResponse } from '@/lib/services/documentTranslation/native/nativeRunResponses';
import {
  isWorkflowFeatureEnabled,
  workflowFeatureDisabledResponse,
} from '@/lib/services/workflows/policy/guard';

import {
  badRequestResponse,
  handleApiError,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { NATIVE_PDF_FEATURE } from '@/lib/utils/shared/translation/nativePdf';
import {
  RUN_RECORD_ID,
  RUN_RECORD_MAX_BYTES,
  isRunFileId,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { auth } from '@/auth';

/**
 * GET /api/document-translation/native/file?run=&storage=&id=
 *
 * One file of a translation run, EXACTLY as stored: an encrypted run's
 * files come back encrypted and the browser decrypts them, so this route
 * never needs the run's key. Only the signed-in person's own runs can be
 * named: app storage is read under their prefix and OneDrive with their
 * token. 404 `RUN_FILES_MISSING` when the file is gone.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  const params = req.nextUrl.searchParams;
  const where = parseRunLocation(
    { runId: params.get('run'), storage: params.get('storage') },
    req,
  );
  if (!where.ok) return badRequestResponse(where.error);
  const id = params.get('id');
  if (!isRunFileId(id)) return badRequestResponse('id must name a run file');
  try {
    const store = await openNativeRunStore(req, session, where.location);
    const stored = await store.getStored(id);
    return new NextResponse(new Uint8Array(stored), {
      headers: {
        'Content-Type': runFileContentType(id, stored),
        'Content-Length': String(stored.length),
        // Server-written files never change; the record does.
        'Cache-Control':
          id === RUN_RECORD_ID ? 'no-store' : 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const response = runStorageErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/file] Read failed:', error);
    return handleApiError(error, 'Could not read the file');
  }
}

/**
 * PUT /api/document-translation/native/file?run=&storage=
 *
 * Saves the run's record: the body is stored as sent (the browser encrypts
 * it when the run is encrypted). The record is the only file a browser can
 * write. Refused (403) while the feature is switched off.
 */
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowFeatureEnabled(NATIVE_PDF_FEATURE))) {
    return workflowFeatureDisabledResponse(NATIVE_PDF_FEATURE);
  }
  const params = req.nextUrl.searchParams;
  const where = parseRunLocation(
    { runId: params.get('run'), storage: params.get('storage') },
    req,
  );
  if (!where.ok) return badRequestResponse(where.error);
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > RUN_RECORD_MAX_BYTES) {
    return payloadTooLargeResponse('The run record is too large');
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return badRequestResponse('The record is empty');
  if (body.length > RUN_RECORD_MAX_BYTES) {
    return payloadTooLargeResponse('The run record is too large');
  }
  try {
    const store = await openNativeRunStore(req, session, where.location);
    await store.putRecord(body);
    return successResponse({ saved: true });
  } catch (error) {
    const response = runStorageErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/file] Save failed:', error);
    return handleApiError(error, 'Could not save the translation');
  }
}
