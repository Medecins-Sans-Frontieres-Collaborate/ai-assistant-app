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
}

/** A step of a server-side upload, in the order it happens. */
export type UploadStage = 'uploading' | 'reading';

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
   */
  constructor(
    message: string,
    readonly code?: string,
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

/**
 * Extracts the text of a file that is already in blob storage.
 *
 * Extraction is cached server-side, so calling this again for the same file
 * (for example to re-read a large document's pages after a reload) is cheap.
 *
 * @param url - Blob reference returned by `/api/file/upload`.
 * @param signal - Aborts the request; the promise then rejects with an
 *   `AbortError`.
 * @returns The file's extracted text.
 * @throws FileTextExtractionError when the server cannot extract text; its
 *   `code` is `NO_EXTRACTABLE_TEXT` for scanned or image-only files.
 * @throws Error when the response is missing the extracted content.
 */
export async function extractTextFromUploadedFile(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
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
    );
  }
  const processData = (await processResponse.json()) as {
    results?: Array<{ content?: unknown }>;
  } | null;
  const content = processData?.results?.[0]?.content;
  if (typeof content !== 'string') {
    throw new Error(
      'Text extraction failed: server response is missing the result',
    );
  }

  return content;
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
    return { url: '', name: file.name, text };
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
  const text = await extractTextFromUploadedFile(url, signal);
  return { url, name: file.name, text };
}
