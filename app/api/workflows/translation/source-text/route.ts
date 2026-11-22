import { NextRequest, NextResponse } from 'next/server';

import {
  NativeRunStore,
  openNativeRunStore,
  parseRunLocation,
  runFileContentType,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import { runStorageErrorResponse } from '@/lib/services/documentTranslation/native/nativeRunResponses';
import {
  isWorkflowEnabled,
  workflowDisabledResponse,
} from '@/lib/services/workflows/policy/guard';

import {
  badRequestResponse,
  handleApiError,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { RUN_RECORD_ID } from '@/lib/utils/shared/translation/nativeRunStorage';
import { STORED_SOURCE_TEXT_MAX_BYTES } from '@/lib/utils/shared/translation/storedSourceText';

import { auth } from '@/auth';

/**
 * A translation's source text, kept out of the browser when it is large
 * (see storedSourceText.ts). One text is one folder holding one file, in
 * the same two places a formatted run can live and under the same rules:
 * the signed-in person's own prefix or OneDrive, deleted from app storage
 * some days after its last write, and stored exactly as the browser sent
 * it, which is encrypted when the person has a backup key.
 *
 * Every method names the text with `?id=<uuid>&storage=<app|onedrive>`.
 */
async function open(
  req: NextRequest,
): Promise<{ store: NativeRunStore } | { response: NextResponse }> {
  const session = await auth();
  if (!session) return { response: unauthorizedResponse() };
  const params = req.nextUrl.searchParams;
  const where = parseRunLocation(
    { runId: params.get('id'), storage: params.get('storage') },
    req,
  );
  if (!where.ok) return { response: badRequestResponse(where.error) };
  try {
    return {
      store: await openNativeRunStore(req, session, where.location, 'texts'),
    };
  } catch (error) {
    return { response: failure(error, 'Could not reach the stored text') };
  }
}

function failure(error: unknown, fallback: string): NextResponse {
  const response = runStorageErrorResponse(error);
  if (response) return response;
  console.error('[workflows/translation/source-text]', fallback, error);
  return handleApiError(error, fallback);
}

/**
 * GET — the text as stored. 404 `RUN_FILES_MISSING` when it is gone.
 */
export async function GET(req: NextRequest) {
  const opened = await open(req);
  if ('response' in opened) return opened.response;
  try {
    const stored = await opened.store.getStored(RUN_RECORD_ID);
    return new NextResponse(new Uint8Array(stored), {
      headers: {
        'Content-Type': runFileContentType(RUN_RECORD_ID, stored),
        'Content-Length': String(stored.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return failure(error, 'Could not read the stored text');
  }
}

/**
 * PUT — stores the body as the text, replacing what was there. Refused
 * (403) while the translation workflow is switched off, and (413) above
 * STORED_SOURCE_TEXT_MAX_BYTES.
 */
export async function PUT(req: NextRequest) {
  if (!(await isWorkflowEnabled('translation'))) {
    return workflowDisabledResponse('translation');
  }
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > STORED_SOURCE_TEXT_MAX_BYTES) {
    return payloadTooLargeResponse('The text is too large to store');
  }
  const opened = await open(req);
  if ('response' in opened) return opened.response;
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return badRequestResponse('The text is empty');
  if (body.length > STORED_SOURCE_TEXT_MAX_BYTES) {
    return payloadTooLargeResponse('The text is too large to store');
  }
  try {
    await opened.store.putRecord(body);
    return successResponse(await opened.store.sync());
  } catch (error) {
    return failure(error, 'Could not store the text');
  }
}

/**
 * POST — keeps the text alive: touches it where files expire, unless the
 * JSON body says `touch: false`, which only asks. Returns `expiresAt`
 * (null on OneDrive). 404 `RUN_FILES_MISSING` when the text is gone.
 */
export async function POST(req: NextRequest) {
  const opened = await open(req);
  if ('response' in opened) return opened.response;
  const body = (await req.json().catch(() => ({}))) as { touch?: unknown };
  try {
    return successResponse(
      await opened.store.sync(undefined, body.touch !== false),
    );
  } catch (error) {
    return failure(error, 'Could not check the stored text');
  }
}

/** DELETE — deletes the text; one already gone is not an error. */
export async function DELETE(req: NextRequest) {
  const opened = await open(req);
  if ('response' in opened) return opened.response;
  try {
    await opened.store.remove();
    return successResponse({ deleted: true });
  } catch (error) {
    return failure(error, 'Could not delete the stored text');
  }
}
