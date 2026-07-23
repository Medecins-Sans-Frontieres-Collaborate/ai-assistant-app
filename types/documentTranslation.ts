/**
 * Document Translation Type Definitions
 *
 * Types and constants for Azure Document Translation feature.
 * Supports synchronous single-file translation with optional glossary.
 */

/**
 * Supported document formats for Azure Document Translation (synchronous API).
 * Source: https://learn.microsoft.com/en-us/azure/ai-services/translator/document-translation/overview
 */
export const DOCUMENT_TRANSLATION_FORMATS = [
  '.txt', // Plain text
  '.html',
  '.htm', // HTML
  '.docx', // Word
  '.xlsx', // Excel
  '.pptx', // PowerPoint
  '.msg', // Outlook
  '.xlf',
  '.xliff', // XLIFF
  '.csv', // CSV
  '.tsv',
  '.tab', // TSV
  '.mhtml',
  '.mht', // MHTML
] as const;

export type DocumentTranslationFormat =
  (typeof DOCUMENT_TRANSLATION_FORMATS)[number];

/**
 * Formats routed through the ASYNCHRONOUS (batch) Document Translation API.
 * The synchronous document:translate endpoint does not handle PDFs; the
 * batch API does. Batch translations upload the source, submit a
 * storageType:'File' batch targeting the standard translated-blob path, and
 * the client polls /api/document-translation/status/{jobId} until done.
 */
export const ASYNC_DOCUMENT_TRANSLATION_FORMATS = ['.pdf'] as const;

/** Whether a filename must take the async (batch) translation path. */
export function requiresAsyncTranslation(filename: string): boolean {
  const ext = `.${filename.split('.').pop()?.toLowerCase() ?? ''}`;
  return (ASYNC_DOCUMENT_TRANSLATION_FORMATS as readonly string[]).includes(
    ext,
  );
}

/**
 * Glossary file formats supported by Azure Document Translation.
 */
export const GLOSSARY_FORMATS = ['.csv', '.tsv', '.xlf', '.xliff'] as const;

export type GlossaryFormat = (typeof GLOSSARY_FORMATS)[number];

/**
 * Content types for document formats used in multipart requests.
 */
export const DOCUMENT_CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  msg: 'application/vnd.ms-outlook',
  xlf: 'application/xliff+xml',
  xliff: 'application/xliff+xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  tab: 'text/tab-separated-values',
  mhtml: 'message/rfc822',
  mht: 'message/rfc822',
};

/**
 * Content types for glossary formats.
 */
export const GLOSSARY_CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xlf: 'application/xliff+xml',
  xliff: 'application/xliff+xml',
};

/** Number of days before translated document expires in blob storage */
export const TRANSLATION_EXPIRY_DAYS = 7;

/**
 * Container in the dedicated translation STAGING storage account
 * (AZURE_BLOB_STORAGE_STAGING_NAME / _EU). Scratch space the Azure
 * Translator batch service reads/writes via short-lived SAS; blobs are
 * auto-purged by the account's 1-day lifecycle rule. User-data storage
 * accounts are never exposed to the Translator.
 */
export const TRANSLATION_STAGING_CONTAINER = 'doc-translation-staging';

/** Maximum document size for synchronous translation (40MB per Azure docs) */
export const MAX_DOCUMENT_SIZE = 40 * 1024 * 1024;

/** Maximum glossary file size (1MB) */
export const MAX_GLOSSARY_SIZE = 1 * 1024 * 1024;

/**
 * Options for document translation request.
 */
export interface DocumentTranslationOptions {
  /** Target language code (required) - e.g., 'es', 'fr', 'de' */
  targetLanguage: string;

  /** Source language code (optional) - auto-detected if not provided */
  sourceLanguage?: string;

  /** Custom translation category (optional) - for custom translation models */
  category?: string;
}

/**
 * Request payload for document translation API.
 */
export interface DocumentTranslationRequest {
  /** The document file to translate */
  document: File;

  /** Target language code */
  targetLanguage: string;

  /** Source language code (optional) */
  sourceLanguage?: string;

  /** Glossary file (optional) */
  glossary?: File;

  /** Custom output filename (optional) */
  customOutputFilename?: string;
}

/**
 * Reference to a translated document stored in blob storage.
 * Similar to TranscriptReference for transcriptions.
 */
/**
 * Returned by the translate route for ASYNC (batch) jobs: everything the UI
 * needs to render an in-conversation pending state and to finalize the full
 * reference once /status reports Succeeded.
 */
export interface DocumentTranslationPendingReference {
  async: true;
  jobId: string;
  originalFilename: string;
  originalFileUrl: string;
  translatedFilename: string;
  targetLanguage: string;
  targetLanguageName: string;
  fileExtension: string;
  submittedAt: string;
}

export interface DocumentTranslationReference {
  /** Original filename before translation */
  originalFilename: string;

  /** URL to download the original uploaded file */
  originalFileUrl: string;

  /** Translated document filename */
  translatedFilename: string;

  /** Unique job/blob identifier */
  jobId: string;

  /** Path in blob storage */
  blobPath: string;

  /** ISO timestamp when the translation expires */
  expiresAt: string;

  /** Target language code */
  targetLanguage: string;

  /** Target language display name in English */
  targetLanguageName: string;

  /** File extension */
  fileExtension: string;
}

/**
 * Response from the document translation API endpoint.
 */
export interface DocumentTranslationResponse {
  /** Whether translation succeeded */
  success: boolean;

  /** Translation reference (on success) */
  reference?: DocumentTranslationReference;

  /** Error message (on failure) */
  error?: string;

  /** Error code for programmatic handling */
  errorCode?: string;
}

/**
 * Checks if a file extension is supported for document translation.
 *
 * @param extension - File extension including the dot (e.g., '.docx')
 * @returns True if the format is supported
 */
export function isSupportedTranslationFormat(extension: string): boolean {
  const ext = extension.toLowerCase();
  return DOCUMENT_TRANSLATION_FORMATS.includes(
    ext as DocumentTranslationFormat,
  );
}

/**
 * Checks if a file extension is supported for glossary files.
 *
 * @param extension - File extension including the dot (e.g., '.csv')
 * @returns True if the format is supported for glossaries
 */
export function isSupportedGlossaryFormat(extension: string): boolean {
  const ext = extension.toLowerCase();
  return GLOSSARY_FORMATS.includes(ext as GlossaryFormat);
}

/**
 * Gets the content type for a document format.
 *
 * @param filename - Filename or extension
 * @returns Content type string or 'application/octet-stream' as fallback
 */
export function getDocumentContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return DOCUMENT_CONTENT_TYPES[ext] || 'application/octet-stream';
}

/**
 * Gets the content type for a glossary format.
 *
 * @param filename - Filename or extension
 * @returns Content type string or 'application/octet-stream' as fallback
 */
export function getGlossaryContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return GLOSSARY_CONTENT_TYPES[ext] || 'application/octet-stream';
}

/**
 * Generates the default output filename for a translated document.
 *
 * @param originalFilename - Original filename
 * @param targetLanguage - Target language code
 * @returns Filename with language suffix (e.g., 'report_es.docx')
 */
export function generateTranslatedFilename(
  originalFilename: string,
  targetLanguage: string,
): string {
  const lastDotIndex = originalFilename.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return `${originalFilename}_${targetLanguage}`;
  }
  const baseName = originalFilename.substring(0, lastDotIndex);
  const extension = originalFilename.substring(lastDotIndex);
  return `${baseName}_${targetLanguage}${extension}`;
}
