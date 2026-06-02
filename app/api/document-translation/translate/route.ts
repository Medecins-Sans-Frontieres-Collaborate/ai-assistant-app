/**
 * Document Translation Endpoint
 *
 * Translates a document using Azure Document Translation API and stores
 * the result in blob storage for download.
 *
 * POST /api/document-translation/translate
 * Content-Type: multipart/form-data
 * Body:
 *   - document: File (required) - The document to translate
 *   - targetLanguage: string (required) - Target language code (e.g., 'es', 'fr')
 *   - sourceLanguage: string (optional) - Source language code (auto-detect if omitted)
 *   - glossary: File (optional) - Glossary file (CSV, TSV, or XLIFF)
 *   - customOutputFilename: string (optional) - Custom filename for output
 *
 * Returns: DocumentTranslationReference on success
 */
import { NextRequest } from 'next/server';

import { DocumentTranslationService } from '@/lib/services/documentTranslation/documentTranslationService';

import { getEnvVariable } from '@/lib/utils/app/env';
import {
  badRequestResponse,
  errorResponse,
  payloadTooLargeResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { AzureBlobStorage } from '@/lib/utils/server/blob/blob';
import { createApiLoggingContext } from '@/lib/utils/server/observability';

import {
  DocumentTranslationReference,
  MAX_DOCUMENT_SIZE,
  MAX_GLOSSARY_SIZE,
  TRANSLATION_EXPIRY_DAYS,
  generateTranslatedFilename,
  getDocumentContentType,
} from '@/types/documentTranslation';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { getDocumentTranslationLanguageByCode } from '@/lib/constants/documentTranslationLanguages';
import {
  isDocumentTranslatableUpload,
  isGlossaryFile,
} from '@/lib/constants/fileTypes';
import { v4 as uuidv4 } from 'uuid';

export const maxDuration = 60; // Allow up to 60 seconds for translation

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
  const document = formData.get('document') as File | null;
  const targetLanguage = formData.get('targetLanguage') as string | null;
  const sourceLanguage = formData.get('sourceLanguage') as string | null;
  const glossary = formData.get('glossary') as File | null;
  const customOutputFilename = formData.get('customOutputFilename') as
    | string
    | null;

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
    const fileExtension =
      document.name.split('.').pop()?.toLowerCase() || 'txt';
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
    };

    return successResponse(reference);
  } catch (error) {
    const errorMessage = ctx.getErrorMessage(error);
    console.error('[DocumentTranslation] Translation failed:', errorMessage);

    // Log error (targetLanguage and sourceLanguage are available from outer scope)
    void ctx.logger.logTranslationError({
      user: session.user,
      sourceLanguage: sourceLanguage || undefined,
      targetLanguage: targetLanguage || undefined,
      contentLength: document?.size,
      isDocumentTranslation: true,
      errorCode: errorMessage.includes('AZURE_TRANSLATOR_ENDPOINT')
        ? 'SERVICE_NOT_CONFIGURED'
        : 'TRANSLATION_FAILED',
      errorMessage,
    });

    // Check for specific error types
    if (errorMessage.includes('AZURE_TRANSLATOR_ENDPOINT')) {
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
