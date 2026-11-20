/**
 * Document Translation Endpoint
 *
 * Translates a document using Azure Document Translation API and stores
 * the result in blob storage for download.
 *
 * POST /api/document-translation/translate
 * Content-Type: multipart/form-data
 * Body:
 *   - document: File (required unless driveId+itemId) - The document to translate
 *   - driveId + itemId: string (optional) - OneDrive/SharePoint source instead
 *     of `document`; the server fetches the bytes with the caller's delegated
 *     Graph token and everything downstream is identical to an upload. The
 *     Translator still only ever sees the staging account.
 *   - targetLanguage: string (required) - Target language code (e.g., 'es', 'fr')
 *   - sourceLanguage: string (optional) - Source language code (auto-detect if omitted)
 *   - glossary: File (optional) - Glossary file (CSV, TSV, or XLIFF)
 *   - customOutputFilename: string (optional) - Custom filename for output
 *
 * Returns: DocumentTranslationReference on success
 */
import { NextRequest } from 'next/server';

import { deckErrorResponse } from '@/lib/services/documentTranslation/deck/deckErrorResponse';
import {
  DECK_SERVICE_EXTENSION,
  PreparedDeck,
  prepareDeck,
} from '@/lib/services/documentTranslation/deck/deckJob';
import { DocumentTranslationService } from '@/lib/services/documentTranslation/documentTranslationService';
import { createTranslationJob } from '@/lib/services/documentTranslation/translationJobStore';
import { GuardResult, guardLimit } from '@/lib/services/limits/routeGuard';
import { isValidGraphId } from '@/lib/services/m365/graphApi';
import {
  fetchDriveItemBuffer,
  m365ImportErrorResponse,
} from '@/lib/services/m365/m365ImportService';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  badRequestResponse,
  errorResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';
import { countPdfPages } from '@/lib/utils/server/file/fileHandling';
import { createApiLoggingContext } from '@/lib/utils/server/observability';
import { sanitizeBlobExtension } from '@/lib/utils/shared/blobPath';
import { fileExtensionOf } from '@/lib/utils/shared/translation/documentMode';

import {
  DocumentTranslationPendingReference,
  DocumentTranslationReference,
  MAX_DOCUMENT_SIZE,
  MAX_GLOSSARY_SIZE,
  TRANSLATION_EXPIRY_DAYS,
  TRANSLATION_PAGES_LIMIT_KEY,
  TRANSLATION_STAGING_CONTAINER,
  generateTranslatedFilename,
  getDocumentContentType,
  requiresAsyncTranslation,
} from '@/types/documentTranslation';
import { isPresentationExtension } from '@/types/documentTranslation';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { getDocumentTranslationLanguageByCode } from '@/lib/constants/documentTranslationLanguages';
import {
  isDocumentTranslatableUpload,
  isGlossaryFile,
} from '@/lib/constants/fileTypes';
import { v4 as uuidv4 } from 'uuid';

// A .ppt is converted first, which can wait for a free slot in the render
// queue (lib/services/presentationRender); the same bound as the formatted
// pipeline's route.
export const maxDuration = 300;

/**
 * Reserves a PDF's pages against the caller's daily page allowance
 * (`feature.translation.pagesPerDay`).
 *
 * Fails open when the page count cannot be read: a file the counter cannot
 * parse is rejected by the translator anyway, and a cost control must not
 * turn a counting fault into a feature outage (same stance as guardLimit).
 *
 * @returns The guard result; `allowed: false` carries the response to return.
 */
async function reservePdfPages(
  session: Parameters<typeof guardLimit>[0],
  request: NextRequest,
  pdf: Buffer,
): Promise<GuardResult> {
  let pageCount: number;
  try {
    pageCount = await countPdfPages(pdf, { signal: request.signal });
  } catch (error) {
    console.warn(
      '[DocumentTranslation] Could not count pages; page allowance not charged:',
      error instanceof Error ? error.message : error,
    );
    return { allowed: true };
  }
  return guardLimit(session, TRANSLATION_PAGES_LIMIT_KEY, {
    req: request,
    amount: pageCount,
  });
}

export async function POST(request: NextRequest) {
  const ctx = createApiLoggingContext();

  // Verify authentication
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequestResponse(
      'Invalid form data. Expected multipart/form-data.',
      'INVALID_FORM_DATA',
    );
  }

  // Extract form fields
  let document = formData.get('document') as File | null;
  const targetLanguage = formData.get('targetLanguage') as string | null;
  const sourceLanguage = formData.get('sourceLanguage') as string | null;
  const glossary = formData.get('glossary') as File | null;
  const customOutputFilename = formData.get('customOutputFilename') as
    | string
    | null;
  // Presentations: speaker notes are translated unless this says 'false'.
  const translateNotes = formData.get('translateNotes') !== 'false';
  const driveId = formData.get('driveId');
  const itemId = formData.get('itemId');

  // M365 source: fetch the bytes server-side and continue exactly as if
  // they had been uploaded. Provenance (the source's folder) is kept so the
  // viewer can offer "save next to original".
  let m365Source: { driveId: string; parentItemId: string } | undefined;
  if (!document && typeof driveId === 'string' && typeof itemId === 'string') {
    if (!isValidGraphId(driveId) || !isValidGraphId(itemId)) {
      return badRequestResponse('Invalid driveId or itemId');
    }
    try {
      const fetched = await fetchDriveItemBuffer(
        request,
        { driveId, itemId },
        { maxBytes: MAX_DOCUMENT_SIZE },
      );
      document = new File([new Uint8Array(fetched.data)], fetched.name, {
        type: fetched.mimeType,
      });
      if (fetched.parentFolder) {
        m365Source = {
          driveId: fetched.parentFolder.driveId,
          parentItemId: fetched.parentFolder.itemId,
        };
      }
    } catch (error) {
      return m365ImportErrorResponse(error);
    }
  }

  // Validate required fields
  if (!document) {
    return badRequestResponse('Document file is required.', 'MISSING_DOCUMENT');
  }

  if (!targetLanguage) {
    return badRequestResponse(
      'Target language is required.',
      'MISSING_TARGET_LANGUAGE',
    );
  }

  // Validate document format (by extension, or MIME type as a fallback)
  if (!isDocumentTranslatableUpload(document.name, document.type)) {
    return badRequestResponse(
      `Unsupported document format. Supported formats: .txt, .html, .docx, .xlsx, .pptx, .pdf, .msg, .xliff, .csv, .tsv, .mhtml`,
      'UNSUPPORTED_FORMAT',
    );
  }

  // Usage limit: document translations per day (docs/LIMITS.md). Checked
  // alongside the existing size gate, before any staging-account work.
  const translationGuard = await guardLimit(
    session,
    'feature.translation.jobsPerDay',
    { req: request },
  );
  if (!translationGuard.allowed && translationGuard.response) {
    return translationGuard.response;
  }
  // Reservations to hand back if the request then fails: a translation that
  // never started must not consume the user's daily allowance.
  const reservationRollbacks: Array<() => Promise<void>> = [];
  if (translationGuard.rollback) {
    reservationRollbacks.push(translationGuard.rollback);
  }

  // Validate document size
  if (document.size > MAX_DOCUMENT_SIZE) {
    return payloadTooLargeResponse(
      `${MAX_DOCUMENT_SIZE / 1024 / 1024}MB`,
      'Document size exceeds maximum allowed size.',
    );
  }

  // Validate glossary if provided
  if (glossary) {
    if (!isGlossaryFile(glossary.name)) {
      return badRequestResponse(
        'Unsupported glossary format. Supported formats: .csv, .tsv, .xlf, .xliff',
        'UNSUPPORTED_GLOSSARY_FORMAT',
      );
    }
    if (glossary.size > MAX_GLOSSARY_SIZE) {
      return payloadTooLargeResponse(
        `${MAX_GLOSSARY_SIZE / 1024 / 1024}MB`,
        'Glossary file size exceeds maximum allowed size.',
      );
    }
  }

  // Validate target language
  const targetLangInfo = getDocumentTranslationLanguageByCode(targetLanguage);
  if (!targetLangInfo) {
    return badRequestResponse(
      `Invalid target language code: ${targetLanguage}`,
      'INVALID_TARGET_LANGUAGE',
    );
  }

  // Validate source language if provided
  if (sourceLanguage) {
    const sourceLangInfo = getDocumentTranslationLanguageByCode(sourceLanguage);
    if (!sourceLangInfo) {
      return badRequestResponse(
        `Invalid source language code: ${sourceLanguage}`,
        'INVALID_SOURCE_LANGUAGE',
      );
    }
  }

  try {
    // Read document buffer
    const documentBuffer = Buffer.from(await document.arrayBuffer());

    // Read glossary buffer if provided
    let glossaryBuffer: Buffer | undefined;
    if (glossary) {
      glossaryBuffer = Buffer.from(await glossary.arrayBuffer());
    }

    // Initialize translation service
    const translationService = new DocumentTranslationService();

    // PDFs can't go through the synchronous document:translate endpoint —
    // they take the ASYNC batch path via the dedicated STAGING storage
    // account: upload the original to user storage (for display/download)
    // AND to staging, submit a storageType:'File' batch against short-lived
    // staging SAS URLs, hand back a jobId, and let the client poll
    // /api/document-translation/status/{jobId}. The status route copies the
    // finished translation from staging into the standard translated-blob
    // path in user storage, so everything downstream (content route,
    // reference format) is shared with the sync path. The Translator service
    // only ever touches the staging account — the firewalled user-data
    // accounts are never exposed to it.
    if (requiresAsyncTranslation(document.name)) {
      // A deck is made ready first: checked, converted from .ppt, its
      // slides counted, and a plain .pptx copy made for the service.
      let deck: PreparedDeck | undefined;
      if (isPresentationExtension(fileExtensionOf(document.name))) {
        try {
          deck = await prepareDeck(
            documentBuffer,
            document.name,
            request.signal,
          );
        } catch (error) {
          const answer = deckErrorResponse(error);
          if (!answer) throw error;
          await Promise.allSettled(reservationRollbacks.map((undo) => undo()));
          return answer;
        }
      }
      // Usage limit: pages per day (a slide counts as a page). Only the
      // batch path has a count that is cheap to read before translating.
      const pagesGuard = deck
        ? await guardLimit(session, TRANSLATION_PAGES_LIMIT_KEY, {
            req: request,
            amount: deck.slides,
          })
        : await reservePdfPages(session, request, documentBuffer);
      if (!pagesGuard.allowed && pagesGuard.response) {
        await Promise.allSettled(reservationRollbacks.map((undo) => undo()));
        return pagesGuard.response;
      }
      if (pagesGuard.rollback) reservationRollbacks.push(pagesGuard.rollback);

      const jobId = uuidv4();
      const fileExtension = deck
        ? deck.extension
        : sanitizeBlobExtension(document.name.split('.').pop(), 'pdf');
      // What the service reads and writes: the deck's .pptx copy, or the
      // file itself.
      const serviceExtension = deck ? DECK_SERVICE_EXTENSION : fileExtension;
      const sourceName = deck ? deck.filename : document.name;
      const keptOriginal = deck ? deck.base : documentBuffer;
      const sentOriginal = deck ? deck.serviceCopy : documentBuffer;
      const translatedFilename =
        customOutputFilename ||
        generateTranslatedFilename(sourceName, targetLanguage);

      const blobStorage = new AzureBlobStorage(
        getEnvVariable({ name: 'AZURE_BLOB_STORAGE_NAME', user: session.user }),
        getEnvVariable({
          name: 'AZURE_BLOB_STORAGE_CONTAINER',
          throwErrorOnFail: false,
          defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
          user: session.user,
        }),
        session.user,
      );

      // Scratch storage the Translator can reach (SAS-gated, auto-purged
      // by a 1-day lifecycle rule). Per-region like user storage, so EU
      // documents stage in the EU account.
      const stagingStorage = new AzureBlobStorage(
        getEnvVariable({
          name: 'AZURE_BLOB_STORAGE_STAGING_NAME',
          user: session.user,
        }),
        TRANSLATION_STAGING_CONTAINER,
        session.user,
      );

      const originalBlobPath = `${session.user.id}/translations/${jobId}_original.${fileExtension}`;
      const stagingOriginalPath = `${session.user.id}/translations/${jobId}_original.${serviceExtension}`;
      const blobPath = `${session.user.id}/translations/${jobId}.${serviceExtension}`;
      const contentType = getDocumentContentType(sourceName);
      // User storage copy — serves the original-file download immediately.
      await blobStorage.upload(originalBlobPath, keptOriginal, {
        blobHTTPHeaders: {
          blobContentType: contentType,
          blobContentDisposition: `attachment; filename="${encodeURIComponent(sourceName)}"`,
        },
      });
      // Staging copy — what the Translator actually reads.
      await stagingStorage.upload(stagingOriginalPath, sentOriginal, {
        blobHTTPHeaders: {
          blobContentType: getDocumentContentType(`x.${serviceExtension}`),
        },
      });

      // Optional glossary stages alongside the source (read SAS).
      let glossaryUrl: string | undefined;
      let glossaryFormat: string | undefined;
      if (glossaryBuffer && glossary) {
        const glossaryExt = sanitizeBlobExtension(
          glossary.name.split('.').pop(),
          'csv',
        );
        const glossaryBlobPath = `${session.user.id}/translations/${jobId}_glossary.${glossaryExt}`;
        await stagingStorage.upload(glossaryBlobPath, glossaryBuffer, {});
        glossaryUrl = await stagingStorage.generateContainerScopedSasUrl(
          glossaryBlobPath,
          4,
          'rl',
        );
        glossaryFormat = glossaryExt === 'tsv' ? 'tsv' : glossaryExt;
      }

      // Container-scoped SAS on staging blob URLs — the exact shape Document
      // Translation requires (its target validation needs `list`, which a
      // blob SAS cannot carry; MS samples sign sr=c with sp=rl / sp=wl).
      // Source: read+list. Target: write+list on a blob that does not exist
      // yet — Azure writes it on completion; the status route copies it into
      // user storage at the same path. Short expiry: jobs finish in minutes.
      const sourceUrl = await stagingStorage.generateContainerScopedSasUrl(
        stagingOriginalPath,
        4,
        'rl',
      );
      const targetUrl = await stagingStorage.generateContainerScopedSasUrl(
        blobPath,
        4,
        'wl',
      );

      const operationId = await translationService.submitBatchTranslation({
        sourceUrl,
        targetUrl,
        targetLanguage,
        sourceLanguage: sourceLanguage || undefined,
        glossaryUrl,
        glossaryFormat,
      });

      await createTranslationJob(blobStorage, {
        jobId,
        userId: session.user.id,
        operationId,
        filename: sourceName,
        translatedFilename,
        ext: fileExtension,
        targetLanguage,
        createdAt: Date.now(),
        ...(m365Source && { m365Source }),
        ...(deck && {
          serviceExt: serviceExtension,
          translateNotes,
          ...(deck.convertedFrom && { convertedFrom: deck.convertedFrom }),
        }),
      });

      console.log(
        `[DocumentTranslation] Batch job submitted: job=${jobId} operation=${operationId}`,
      );

      const pending: DocumentTranslationPendingReference = {
        async: true,
        jobId,
        originalFilename: sourceName,
        originalFileUrl: `/api/document-translation/content/${jobId}?filename=${encodeURIComponent(sourceName)}&ext=${fileExtension}&original=true`,
        translatedFilename,
        targetLanguage,
        targetLanguageName: targetLangInfo.englishName,
        fileExtension,
        submittedAt: new Date().toISOString(),
      };
      return successResponse(pending, undefined, 202);
    }

    // Translate the document
    const translatedBuffer = await translationService.translateDocument(
      documentBuffer,
      document.name,
      {
        targetLanguage,
        sourceLanguage: sourceLanguage || undefined,
      },
      glossaryBuffer,
      glossary?.name,
    );

    // Generate job ID and output filename
    const jobId = uuidv4();
    const fileExtension = sanitizeBlobExtension(
      document.name.split('.').pop(),
      'txt',
    );
    const translatedFilename =
      customOutputFilename ||
      generateTranslatedFilename(document.name, targetLanguage);

    // Initialize blob storage
    const blobStorage = new AzureBlobStorage(
      getEnvVariable({
        name: 'AZURE_BLOB_STORAGE_NAME',
        user: session.user,
      }),
      getEnvVariable({
        name: 'AZURE_BLOB_STORAGE_CONTAINER',
        throwErrorOnFail: false,
        defaultValue: env.AZURE_BLOB_STORAGE_IMAGE_CONTAINER ?? '',
        user: session.user,
      }),
      session.user,
    );

    // Store original document in blob storage (for user message display)
    const originalBlobPath = `${session.user.id}/translations/${jobId}_original.${fileExtension}`;
    const contentType = getDocumentContentType(document.name);

    await blobStorage.upload(originalBlobPath, documentBuffer, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobContentDisposition: `attachment; filename="${encodeURIComponent(document.name)}"`,
      },
    });

    // Store translated document in blob storage
    const blobPath = `${session.user.id}/translations/${jobId}.${fileExtension}`;

    await blobStorage.upload(blobPath, translatedBuffer, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobContentDisposition: `attachment; filename="${encodeURIComponent(translatedFilename)}"`,
      },
    });

    // Calculate expiration date
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + TRANSLATION_EXPIRY_DAYS);

    console.log(
      `[DocumentTranslation] Stored translation for job ${jobId}: original=${originalBlobPath}, translated=${blobPath}`,
    );

    // Log success
    void ctx.logger.logTranslationSuccess({
      user: session.user,
      sourceLanguage: sourceLanguage || undefined,
      targetLanguage,
      contentLength: document.size,
      isDocumentTranslation: true,
      duration: ctx.timer.elapsed(),
    });

    // Build original file URL
    const originalFileUrl = `/api/document-translation/content/${jobId}?filename=${encodeURIComponent(document.name)}&ext=${fileExtension}&original=true`;

    const reference: DocumentTranslationReference = {
      originalFilename: document.name,
      originalFileUrl,
      translatedFilename,
      jobId,
      blobPath,
      expiresAt: expiresAt.toISOString(),
      targetLanguage,
      targetLanguageName: targetLangInfo.englishName,
      fileExtension,
      ...(m365Source && { m365Source }),
    };

    return successResponse(reference);
  } catch (error) {
    await Promise.allSettled(reservationRollbacks.map((undo) => undo()));
    const errorMessage = ctx.getErrorMessage(error);
    // Full error object server-side — Azure SDK errors hide the useful
    // parts (code, statusCode, request URL) outside .message.
    console.error('[DocumentTranslation] Translation failed:', error);

    // Log error (targetLanguage and sourceLanguage are available from outer scope)
    void ctx.logger.logTranslationError({
      user: session.user,
      sourceLanguage: sourceLanguage || undefined,
      targetLanguage: targetLanguage || undefined,
      contentLength: document?.size,
      isDocumentTranslation: true,
      errorCode:
        errorMessage.includes('AZURE_TRANSLATOR_ENDPOINT') ||
        errorMessage.includes('AZURE_BLOB_STORAGE_STAGING_NAME')
          ? 'SERVICE_NOT_CONFIGURED'
          : 'TRANSLATION_FAILED',
      errorMessage,
    });

    // Check for specific error types
    if (
      errorMessage.includes('AZURE_TRANSLATOR_ENDPOINT') ||
      errorMessage.includes('AZURE_BLOB_STORAGE_STAGING_NAME')
    ) {
      return errorResponse(
        'Document translation service is not configured. Please contact your administrator.',
        500,
        undefined,
        'SERVICE_NOT_CONFIGURED',
      );
    }

    return errorResponse(
      `Document translation failed: ${errorMessage}`,
      500,
      undefined,
      'TRANSLATION_FAILED',
    );
  }
}
