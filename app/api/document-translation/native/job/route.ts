import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { deckErrorResponse } from '@/lib/services/documentTranslation/deck/deckErrorResponse';
import { prepareDeck } from '@/lib/services/documentTranslation/deck/deckJob';
import {
  DeckJobState,
  DeckRunActiveError,
  assertSlotFree,
  isStalled,
  readDeckJob,
  resumeDeckJob,
  startDeckJob,
  stopDeckJob,
} from '@/lib/services/documentTranslation/native/deckRunJob';
import { BlobDeckRunSlot } from '@/lib/services/documentTranslation/native/deckRunSlot';
import {
  NativeRunStore,
  openNativeRunStore,
  parseRunLocation,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import { readNativeRunOptions } from '@/lib/services/documentTranslation/native/nativeRunForm';
import { runStorageErrorResponse } from '@/lib/services/documentTranslation/native/nativeRunResponses';
import { getRenderService } from '@/lib/services/documents/render/renderService';
import {
  getWorkflowFeatureLimits,
  isWorkflowFeatureEnabled,
  workflowFeatureDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  errorResponse,
  handleApiError,
  notFoundResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { NativeDeckJobView } from '@/lib/utils/shared/translation/nativeDeckJob';
import {
  NATIVE_DECK_MAX_BYTES,
  isNativeDeckFormat,
  nativeUploadExtension,
} from '@/lib/utils/shared/translation/nativeFormats';
import {
  NATIVE_PDF_FEATURE,
  NATIVE_PDF_MAX_PAGES,
  nativePdfLimits,
  splitIntoRequests,
} from '@/lib/utils/shared/translation/nativePdf';

import { auth } from '@/auth';

export const maxDuration = 300;

/**
 * What the browser is told about a job: its state without what it was
 * asked (glossary, instructions), which the browser already has.
 */
function jobView(state: DeckJobState): NativeDeckJobView {
  const { request, ...rest } = state;
  return {
    ...rest,
    sourceName: request.sourceName,
    format: request.format,
    convertedFrom: request.convertedFrom,
    repaired: request.repaired,
    targetLanguage: request.targetLanguage,
    parts: request.batches.length,
    pageCount: request.batches.reduce((sum, batch) => sum + batch.length, 0),
    translateNotes: request.translateNotes,
  };
}

/** Opens a run's folder from query or form fields, or answers why not. */
async function openStore(
  req: NextRequest,
  session: Session,
  fields: { runId: unknown; storage: unknown },
): Promise<{ store: NativeRunStore } | { response: Response }> {
  const where = parseRunLocation(fields, req);
  if (!where.ok) return { response: badRequestResponse(where.error) };
  try {
    return { store: await openNativeRunStore(req, session, where.location) };
  } catch (error) {
    const response = runStorageErrorResponse(error);
    if (response) return { response };
    throw error;
  }
}

/**
 * POST /api/document-translation/native/job — translates a presentation
 * with Preserve formatting, in the background (THE JOB CONVENTION in
 * deckRunJob.ts). Answers 202 at once with the job's state; its progress
 * is read with GET.
 *
 * Multipart fields: `file` (.pptx, .pptm, .ppsx, .potx or .ppt; a .ppt is
 * converted to .pptx first), `runId`, `storage`, `translateNotes`
 * ("false" leaves speaker notes as they are), `modelId`,
 * `conversationId`, and the run options read by readNativeRunOptions
 * (`pages` may name up to the person's largest batch; the job splits it).
 *
 * 409 `DECK_RUN_ACTIVE` while the person has another presentation going;
 * 422 for a file that is not a readable presentation; 503 when the render
 * queue is full (converting a .ppt).
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  if (!(await isWorkflowFeatureEnabled(NATIVE_PDF_FEATURE))) {
    return workflowFeatureDisabledResponse(NATIVE_PDF_FEATURE);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return badRequestResponse('Expected multipart form data');
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return badRequestResponse('A presentation file is required');
  }
  const extension = nativeUploadExtension(file.name);
  if (!extension || (extension !== 'ppt' && !isNativeDeckFormat(extension))) {
    return badRequestResponse(
      'The file must be a PowerPoint presentation (.pptx, .pptm, .ppsx, .potx or .ppt)',
    );
  }
  if (file.size > NATIVE_DECK_MAX_BYTES) {
    return payloadTooLargeResponse('The presentation is too large');
  }

  const limits = nativePdfLimits(
    await getWorkflowFeatureLimits(NATIVE_PDF_FEATURE, session),
  );
  const read = await readNativeRunOptions(
    form,
    req,
    session,
    limits.maxBatchPages,
  );
  if (!read.ok) return badRequestResponse(read.error);
  const { options } = read;

  const opened = await openStore(req, session, {
    runId: form.get('runId'),
    storage: form.get('storage'),
  });
  if ('response' in opened) return opened.response;
  const { store } = opened;

  // Nothing is spent unless the person has budget left.
  const { denied } = await beginWorkflowRun(
    session,
    'native-deck-translate',
    form.get('conversationId'),
  );
  if (denied) return denied;

  // Checked, and a .ppt converted, before anything is stored or charged.
  let deck: Awaited<ReturnType<typeof prepareDeck>>;
  try {
    deck = await prepareDeck(
      Buffer.from(await file.arrayBuffer()),
      file.name,
      req.signal,
    );
  } catch (error) {
    const response = deckErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/job] Prepare failed:', error);
    return handleApiError(error, 'Could not read the presentation');
  }
  const slides = options.pages.filter((page) => page <= deck.slides);
  if (slides.length === 0) {
    return badRequestResponse(
      `The presentation has ${deck.slides} slides; choose slides between 1 and ${deck.slides}`,
    );
  }

  const slot = BlobDeckRunSlot.open(session);
  try {
    // Refused before anything is stored for the run.
    await assertSlotFree(slot, store.location.runId, Date.now());
    const source = await store.put(deck.base, deck.extension);
    const state = await startDeckJob({
      store,
      slot,
      user: session.user,
      request: {
        sourceName: deck.filename,
        sourceId: source.id,
        format: deck.extension,
        ...(deck.convertedFrom ? { convertedFrom: deck.convertedFrom } : {}),
        targetLanguage: options.targetLanguage,
        depth: options.depth,
        instructions: options.instructions,
        refitRounds: options.refitRounds,
        translateNotes: form.get('translateNotes') !== 'false',
        modelId: resolveWorkflowModelId(
          (form.get('modelId') as string | null) ?? undefined,
        ),
        glossaryEntries: options.glossaryEntries,
        ...(options.brief ? { brief: options.brief } : {}),
        ...(typeof form.get('conversationId') === 'string'
          ? { conversationId: form.get('conversationId') as string }
          : {}),
        batches: splitIntoRequests(slides, NATIVE_PDF_MAX_PAGES),
      },
      deps: { maxDocumentPages: limits.maxDocumentPages },
    });
    return successResponse(
      { job: jobView(state), sourceUrl: source.url, sourceId: source.id },
      undefined,
      202,
    );
  } catch (error) {
    if (error instanceof DeckRunActiveError) {
      return errorResponse(
        error.message,
        409,
        {
          activeName: error.active.sourceName,
          activeRunId: error.active.runId,
        },
        error.code,
      );
    }
    const response = runStorageErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/job] Start failed:', error);
    return handleApiError(error, 'Could not start the translation');
  }
}

/**
 * GET /api/document-translation/native/job?run=&storage=
 *
 * The job's progress: its status, the batch in progress with its steps
 * and its place in the render queue, the finished batches' reports and,
 * when there were several, the joined document. A job no instance is
 * running any more (a restart) is picked up again by this read and goes
 * on from the first unfinished batch (THE JOB CONVENTION). 404 when the
 * run has no job.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  const params = req.nextUrl.searchParams;
  const opened = await openStore(req, session, {
    runId: params.get('run'),
    storage: params.get('storage'),
  });
  if ('response' in opened) return opened.response;
  const { store } = opened;
  try {
    let state = await readDeckJob(store);
    if (!state) return notFoundResponse('This run has no presentation job');
    if (isStalled(state, Date.now())) {
      // Only picked up again while the feature is on and budget is left.
      const enabled = await isWorkflowFeatureEnabled(NATIVE_PDF_FEATURE);
      const { denied } = await beginWorkflowRun(
        session,
        'native-deck-translate',
        state.request.conversationId,
      );
      if (enabled && !denied) {
        const limits = nativePdfLimits(
          await getWorkflowFeatureLimits(NATIVE_PDF_FEATURE, session),
        );
        state = await resumeDeckJob({
          store,
          slot: BlobDeckRunSlot.open(session),
          user: session.user,
          state,
          deps: { maxDocumentPages: limits.maxDocumentPages },
        });
      }
    }
    const queue = getRenderService().snapshot();
    return successResponse({ job: jobView(state), queue });
  } catch (error) {
    if (error instanceof DeckRunActiveError) {
      return errorResponse(
        error.message,
        409,
        {
          activeName: error.active.sourceName,
          activeRunId: error.active.runId,
        },
        error.code,
      );
    }
    const response = runStorageErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/job] Read failed:', error);
    return handleApiError(error, 'Could not read the translation job');
  }
}

/**
 * DELETE /api/document-translation/native/job?run=&storage=
 *
 * Stops the job. Finished batches are kept; the batch in progress is
 * discarded. Stopping a job that has ended succeeds and changes nothing.
 */
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  const params = req.nextUrl.searchParams;
  const opened = await openStore(req, session, {
    runId: params.get('run'),
    storage: params.get('storage'),
  });
  if ('response' in opened) return opened.response;
  try {
    const state = await readDeckJob(opened.store);
    if (!state) return notFoundResponse('This run has no presentation job');
    return successResponse({
      job: jobView(await stopDeckJob(opened.store, state)),
    });
  } catch (error) {
    const response = runStorageErrorResponse(error);
    if (response) return response;
    console.error('[document-translation/native/job] Stop failed:', error);
    return handleApiError(error, 'Could not stop the translation');
  }
}
