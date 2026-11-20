import { NextRequest } from 'next/server';

import { resolveRequestGlossary } from '@/lib/services/documentTranslation/native/nativePdfGlossary';
import { runNativePdfTranslation } from '@/lib/services/documentTranslation/native/nativePdfPipeline';
import {
  NativeRunStore,
  openNativeRunStore,
  parseRunLocation,
} from '@/lib/services/documentTranslation/native/nativePdfStorage';
import { runStorageErrorResponse } from '@/lib/services/documentTranslation/native/nativeRunResponses';
import {
  getWorkflowFeatureLimits,
  isWorkflowFeatureEnabled,
  workflowFeatureDisabledResponse,
} from '@/lib/services/workflows/policy/guard';
import { resolveWorkflowModelId } from '@/lib/services/workflows/shared/workflowModels';
import { beginWorkflowRun } from '@/lib/services/workflows/shared/workflowUsage';

import {
  badRequestResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  NATIVE_PDF_DEFAULT_DEPTH,
  NATIVE_PDF_DEFAULT_REFIT_ROUNDS,
  NATIVE_PDF_DEPTHS,
  NATIVE_PDF_FEATURE,
  NATIVE_PDF_MAX_PAGES,
  NATIVE_PDF_MAX_REFIT_ROUNDS,
  NativePdfDepth,
  NativePdfRunReport,
  NativePdfStreamEvent,
  nativePdfLimits,
  parsePageSelection,
  sanitizeBrief,
  sanitizeStepInstructions,
} from '@/lib/utils/shared/translation/nativePdf';

import { auth } from '@/auth';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';

export const maxDuration = 300;

/** Largest PDF accepted; the file is uploaded to the sandbox twice per run. */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_LANGUAGE_LABEL_CHARS = 80;
const PDF_SIGNATURE = '%PDF-';

/** A JSON form field parsed, or undefined when absent or not JSON. */
function jsonField(form: FormData, name: string): unknown {
  const raw = form.get(name);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * GET /api/document-translation/native — whether formatting-preserving PDF
 * translation is available here, and its limits. The workspace offers the
 * option only when this says so.
 *
 * `limits` are the signed-in person's own (an admin may have set different
 * ones for them): the default and largest batch, and the document total.
 * `maxPages` is how many pages one request takes; a larger batch is sent
 * as several requests.
 */
export async function GET() {
  const session = await auth();
  if (!session) return unauthorizedResponse();
  return successResponse({
    enabled: await isWorkflowFeatureEnabled(NATIVE_PDF_FEATURE),
    limits: nativePdfLimits(
      await getWorkflowFeatureLimits(NATIVE_PDF_FEATURE, session),
    ),
    maxPages: NATIVE_PDF_MAX_PAGES,
    maxRefitRounds: NATIVE_PDF_MAX_REFIT_ROUNDS,
  });
}

/**
 * POST /api/document-translation/native — experimental native PDF
 * translation. Runs the fixed extract → analyze → translate → rebuild →
 * verify → refit pipeline on up to NATIVE_PDF_MAX_PAGES pages
 * (fewer when the person's largest batch is smaller). A batch of more pages
 * is several of these requests, put together afterwards by
 * POST .../native/render.
 *
 * Responds with a stream of newline-delimited JSON events
 * (NativePdfStreamEvent): one `step` line when a step starts and one when it
 * ends, then a single `result` (the translated PDF's url, page images, every
 * step and unit, and the `sourceId` / `unitsId` that POST .../native/render
 * takes to lay the pages out again after an edit) or `error`. Validation
 * failures are ordinary JSON error responses, sent before the stream opens.
 *
 * Multipart fields:
 *   file            the PDF
 *   targetLanguage  display label of the target language
 *   pages           optional selection such as "1,8,21" or "2-4"
 *   instructions    optional JSON: { analyze?, translate?, verify? } — text
 *                   added to those steps' prompts; steps cannot be skipped
 *   depth           optional "quick" (default) or "reviewed"
 *   glossaryEntries optional JSON array of personal glossary entries
 *   glossaryGuideIds optional JSON array of organization glossary ids
 *   brief           optional JSON: the document brief an earlier request for
 *                   this document returned (its language and the names and
 *                   terms already decided), so every request translates
 *                   the same way; the result returns it with additions
 *   modelId         optional workflow model
 *   refitRounds     optional 0..NATIVE_PDF_MAX_REFIT_ROUNDS
 *   runId           the run the files belong to (a UUID the client made
 *                   for the document's first batch and sends ever after)
 *   storage         "app" or "onedrive": where the run's files live
 *
 * A run that is encrypted sends its key in the RUN_KEY_HEADER header (see
 * nativeRunStorage.ts); everything stored is then encrypted with it.
 *
 * Refused (403) while an admin has the Preserve formatting feature or the
 * translation workflow switched off (Admin > Workflows).
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
  if (!(file instanceof File))
    return badRequestResponse('A PDF file is required');
  if (file.size > MAX_PDF_BYTES) {
    return payloadTooLargeResponse(
      'The PDF is too large for native translation',
    );
  }
  const document = Buffer.from(await file.arrayBuffer());
  if (
    document.subarray(0, PDF_SIGNATURE.length).toString('latin1') !==
    PDF_SIGNATURE
  ) {
    return badRequestResponse('The file is not a PDF');
  }

  const targetLanguage = String(form.get('targetLanguage') ?? '').trim();
  if (!targetLanguage) return badRequestResponse('Target language is required');
  if (targetLanguage.length > MAX_LANGUAGE_LABEL_CHARS) {
    return badRequestResponse('Target language name is too long');
  }

  // One request takes NATIVE_PDF_MAX_PAGES at most, and never more than
  // the person's largest batch when an admin has set that lower.
  const limits = nativePdfLimits(
    await getWorkflowFeatureLimits(NATIVE_PDF_FEATURE, session),
  );
  const selection = parsePageSelection(
    form.get('pages') as string | null,
    Math.min(NATIVE_PDF_MAX_PAGES, limits.maxBatchPages),
  );
  if (!selection.ok) return badRequestResponse(selection.error);

  const instructions = sanitizeStepInstructions(
    jsonField(form, 'instructions'),
  );

  const depth = String(form.get('depth') ?? NATIVE_PDF_DEFAULT_DEPTH);
  if (!(NATIVE_PDF_DEPTHS as readonly string[]).includes(depth)) {
    return badRequestResponse(
      `depth must be one of: ${NATIVE_PDF_DEPTHS.join(', ')}`,
    );
  }

  const glossary = await resolveRequestGlossary(req, session, {
    glossaryEntries: jsonField(form, 'glossaryEntries'),
    glossaryGuideIds: jsonField(form, 'glossaryGuideIds'),
  });
  if ('error' in glossary) return badRequestResponse(glossary.error);

  const requestedRounds = Number(
    form.get('refitRounds') ?? NATIVE_PDF_DEFAULT_REFIT_ROUNDS,
  );
  if (
    !Number.isInteger(requestedRounds) ||
    requestedRounds < 0 ||
    requestedRounds > NATIVE_PDF_MAX_REFIT_ROUNDS
  ) {
    return badRequestResponse(
      `Refit rounds must be between 0 and ${NATIVE_PDF_MAX_REFIT_ROUNDS}`,
    );
  }

  const where = parseRunLocation(
    { runId: form.get('runId'), storage: form.get('storage') },
    req,
  );
  if (!where.ok) return badRequestResponse(where.error);
  let store: NativeRunStore;
  try {
    // Opened before any tokens are spent: OneDrive must be reachable.
    store = await openNativeRunStore(req, session, where.location);
  } catch (error) {
    const response = runStorageErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { denied, usage } = await beginWorkflowRun(
    session,
    'native-pdf-translate',
    form.get('conversationId'),
  );
  if (denied) return denied;

  // Progress is streamed as newline-delimited JSON (NativePdfStreamEvent):
  // the run takes minutes, and the workspace shows each step as it happens.
  const encoder = new TextEncoder();
  let open = true;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
    cancel() {
      open = false;
    },
  });
  const send = (event: NativePdfStreamEvent): void => {
    if (!open) return;
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      open = false;
    }
  };

  void (async () => {
    try {
      const result = await runNativePdfTranslation({
        document,
        targetLanguage,
        pages: selection.pages,
        instructions,
        modelId: resolveWorkflowModelId(
          (form.get('modelId') as string | null) ?? undefined,
        ),
        maxRefitRounds: requestedRounds,
        depth: depth as NativePdfDepth,
        glossaryEntries: glossary.entries,
        brief: sanitizeBrief(jsonField(form, 'brief')),
        onStep: (step) => send({ type: 'step', ...step }),
        signal: req.signal,
        usage,
      });

      const { pdf, outputs, unitsFile, ...report } = result;
      // The source and the extraction are kept so the pages can be laid out
      // again with edited translations (POST .../native/render).
      const [rebuild, source, units] = await Promise.all([
        store.putRebuild({ pdf, outputs }),
        store.put(document, 'pdf'),
        store.put(unitsFile, 'json'),
      ]);
      const data: NativePdfRunReport = {
        ...report,
        ...rebuild,
        sourceId: source.id,
        unitsId: units.id,
      };
      send({ type: 'result', data: { ...data, ...usage.fields() } });
    } catch (error) {
      // A stopped run is the caller's doing, not a failure to log.
      if (!req.signal.aborted) {
        console.error('[document-translation/native] Failed:', error);
      }
      send({
        type: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Native PDF translation failed',
      });
    } finally {
      if (open) {
        open = false;
        try {
          controller.close();
        } catch {
          // already closed by cancellation
        }
      }
    }
  })();

  return new Response(stream, { headers: STREAMING_RESPONSE_HEADERS });
}
