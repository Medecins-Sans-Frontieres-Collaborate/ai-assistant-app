'use client';

/**
 * Uploads a file to blob storage and returns its extracted plain text.
 * Shared by the workflow workspaces (document references, translation
 * source upload, data extraction sources, map inputs) — same
 * `/api/file/upload` → `/api/file/process` path the chat surface uses, so
 * extraction, caching, and per-user namespacing are identical.
 */

export interface ExtractedFileText {
  /** Blob reference (relative /api/file/... or absolute URL). */
  url: string;
  name: string;
  text: string;
  /**
   * True when the server can read this file again with OCR. Always false
   * for files read in the browser.
   */
  ocrAvailable: boolean;
}

/**
 * A step of a server-side upload. `uploading` then `reading` happen on
 * every upload; `ocr` is a separate, user-requested reading of a stored
 * file.
 */
export type UploadStage = 'uploading' | 'reading' | 'ocr';

/** What a failed extraction still knows about the file. */
export interface FileTextExtractionContext {
  /** Blob reference of the file, when it was stored before the failure. */
  url?: string;
  /** True when the server offers OCR for the file. */
  ocrAvailable?: boolean;
  /** HTTP status of the failed response. */
  status?: number;
}

/** Optional controls for {@link uploadAndExtractText}. */
export interface UploadAndExtractOptions {
  /** Aborts the upload or the extraction, whichever is in flight. */
  signal?: AbortSignal;
  /**
   * Called when a server-side step starts. Never called for files read in
   * the browser, which have no steps worth showing.
   */
  onStage?: (stage: UploadStage) => void;
}

/** Processing failure with a stable server code for localized UI handling. */
export class FileTextExtractionError extends Error {
  /**
   * @param message - Human-readable extraction failure.
   * @param code - Optional machine-readable server error code.
   * @param context - What is still known about the file, e.g. where it is
   *   stored, so the caller can offer another way to read it.
   */
  constructor(
    message: string,
    readonly code?: string,
    readonly context: FileTextExtractionContext = {},
  ) {
    super(message);
    this.name = 'FileTextExtractionError';
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Plain-text types we can read locally without an upload round-trip. */
const LOCAL_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

const LOCAL_TEXT_EXTENSIONS = /\.(txt|md|csv|json|tsv)$/i;

/** Text of a stored file, and whether OCR could read it again. */
export interface UploadedFileText {
  text: string;
  ocrAvailable: boolean;
}

/**
 * Extracts the text of a file that is already in blob storage.
 *
 * Extraction is cached server-side, so calling this again for the same file
 * (for example to re-read a large document's pages after a reload) is cheap.
 * A file that was read with OCR returns its OCR text.
 *
 * @param url - Blob reference returned by `/api/file/upload`.
 * @param signal - Aborts the request; the promise then rejects with an
 *   `AbortError`.
 * @returns The file's extracted text.
 * @throws FileTextExtractionError when the server cannot extract text; its
 *   `code` is `NO_EXTRACTABLE_TEXT` for scanned or image-only files, and
 *   its `context` says where the file is and whether OCR is offered.
 * @throws Error when the response is missing the extracted content.
 */
export async function extractTextFromUploadedFile(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await extractUploadedFile(url, signal)).text;
}

/**
 * Same as {@link extractTextFromUploadedFile}, also reporting whether the
 * server can read the file again with OCR.
 */
export async function extractUploadedFile(
  url: string,
  signal?: AbortSignal,
): Promise<UploadedFileText> {
  const processResponse = await fetch('/api/file/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  if (!processResponse.ok) {
    const errorData = await processResponse.json().catch(() => ({}));
    throw new FileTextExtractionError(
      errorData.error || `Text extraction failed (${processResponse.status})`,
      typeof errorData.code === 'string' ? errorData.code : undefined,
      {
        url,
        ocrAvailable: errorData.ocrAvailable === true,
        status: processResponse.status,
      },
    );
  }
  const processData = (await processResponse.json()) as {
    results?: Array<{ content?: unknown }>;
    ocrAvailable?: unknown;
  } | null;
  const content = processData?.results?.[0]?.content;
  if (typeof content !== 'string') {
    throw new Error(
      'Text extraction failed: server response is missing the result',
    );
  }

  return { text: content, ocrAvailable: processData?.ocrAvailable === true };
}

/** Text read from a stored file by OCR. */
export interface OcrFileText {
  /** Paged text, in the same format as extracted PDF text. */
  text: string;
  /** Pages read, and charged against the daily OCR allowance. */
  pageCount: number;
}

/**
 * Reads a stored PDF with OCR. The result replaces the file's cached text
 * on the server, so later extractions of the same file return it.
 *
 * @param url - Blob reference returned by `/api/file/upload`.
 * @param signal - Aborts the request; the promise then rejects with an
 *   `AbortError`.
 * @throws FileTextExtractionError when OCR is refused or fails. `code` is
 *   one of `OCR_ERROR` (lib/utils/shared/file/ocr.ts); `context.status` is
 *   429 when the daily page allowance is exhausted.
 */
export async function ocrUploadedFile(
  url: string,
  signal?: AbortSignal,
): Promise<OcrFileText> {
  const response = await fetch('/api/file/ocr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal,
  });
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
    data?: { content?: unknown; pageCount?: unknown };
  } | null;
  if (!response.ok) {
    throw new FileTextExtractionError(
      typeof body?.error === 'string'
        ? body.error
        : `OCR failed (${response.status})`,
      typeof body?.code === 'string' ? body.code : undefined,
      { url, status: response.status },
    );
  }
  const content = body?.data?.content;
  if (typeof content !== 'string') {
    throw new Error('OCR failed: server response is missing the result');
  }
  return {
    text: content,
    pageCount:
      typeof body?.data?.pageCount === 'number' ? body.data.pageCount : 0,
  };
}

/**
 * Uploads a file and returns its extracted text. Plain-text files are read
 * in the browser and never leave it (their `url` is empty).
 *
 * @param file - The file the user chose.
 * @param options - Optional abort signal and stage callback.
 * @returns The blob reference, file name, and extracted text.
 * @throws FileTextExtractionError when the server cannot extract text.
 * @throws Error when the upload fails, or an `AbortError` when aborted.
 */
export async function uploadAndExtractText(
  file: File,
  options: UploadAndExtractOptions = {},
): Promise<ExtractedFileText> {
  const { signal, onStage } = options;
  // Cheap path: plain-text files are read in the browser.
  if (
    !/\.pdf$/i.test(file.name) &&
    (LOCAL_TEXT_TYPES.has(file.type) || LOCAL_TEXT_EXTENSIONS.test(file.name))
  ) {
    const text = await file.text();
    return { url: '', name: file.name, text, ocrAvailable: false };
  }

  onStage?.('uploading');
  const base64Data = await readAsBase64(file);
  const encodedFileName = encodeURIComponent(file.name);
  const encodedMimeType = encodeURIComponent(file.type);

  const uploadResponse = await fetch(
    `/api/file/upload?filename=${encodedFileName}&filetype=file&mime=${encodedMimeType}`,
    {
      method: 'POST',
      body: base64Data,
      headers: { 'x-file-name': encodedFileName },
      signal,
    },
  );
  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json().catch(() => ({}));
    throw new Error(
      errorData.error || `Upload failed (${uploadResponse.status})`,
    );
  }
  const uploadData = (await uploadResponse.json()) as {
    data?: { uri?: unknown };
  } | null;
  const url = uploadData?.data?.uri;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('Upload failed: server response is missing the file URL');
  }

  onStage?.('reading');
  const { text, ocrAvailable } = await extractUploadedFile(url, signal);
  return { url, name: file.name, text, ocrAvailable };
}
