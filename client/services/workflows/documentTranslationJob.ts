'use client';

/**
 * Client for whole-document translation jobs (`/api/document-translation/*`),
 * as the Translation workspace uses them: submit a file, follow the job,
 * read its text a few pages at a time, save page corrections, and download
 * the results.
 */
import {
  DocumentTranslationPendingReference,
  DocumentTranslationReference,
} from '@/types/documentTranslation';

/** A failed request, with the server's stable code when it sent one. */
export class DocumentJobError extends Error {
  /**
   * @param message - Human-readable failure, from the server when available.
   * @param status - HTTP status of the response.
   * @param code - Machine-readable server error code, if any.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DocumentJobError';
  }
}

/** Where a job stands, as the status endpoint reports it. */
export type DocumentJobStatus =
  | { status: 'Running' }
  | { status: 'Succeeded'; reference: DocumentTranslationReference }
  | { status: 'Failed'; error: string }
  /** The job record is gone: expired, or never existed for this user. */
  | { status: 'NotFound' };

/** One page of a job's text. */
export interface DocumentJobPage {
  /** 1-based page number. */
  page: number;
  source: string;
  /** The machine translation, before any correction. */
  translation: string;
  /** The user's replacement text for the page, when one was saved. */
  correction?: { text: string; updatedAt: string };
}

/** A window of a job's pages. */
export interface DocumentJobPages {
  pageCount: number;
  /** False when page N may not show the same content on both sides. */
  pagesAligned: boolean;
  from: number;
  to: number;
  pages: DocumentJobPage[];
  /** Every page that has a correction, ascending. */
  correctedPages: number[];
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  return (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
}

async function failure(
  response: Response,
  fallback: string,
): Promise<DocumentJobError> {
  const body = await readJson(response);
  return new DocumentJobError(
    typeof body?.error === 'string'
      ? body.error
      : `${fallback} (${response.status})`,
    response.status,
    typeof body?.code === 'string' ? body.code : undefined,
  );
}

/** Unwraps the `{ success, data }` envelope the API responds with. */
async function dataOf<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) throw await failure(response, fallback);
  const body = await readJson(response);
  if (!body?.data) throw new DocumentJobError(fallback, response.status);
  return body.data as T;
}

/**
 * Fetches a file that is already in blob storage, to submit it again.
 *
 * @param url - Blob reference returned by `/api/file/upload`.
 * @param name - Filename to give the file.
 * @throws DocumentJobError when the file cannot be read (e.g. it expired).
 */
export async function fetchStoredFile(
  url: string,
  name: string,
  signal?: AbortSignal,
): Promise<File> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw await failure(response, 'Could not read the file');
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

/**
 * Submits a document for whole-document translation.
 *
 * @param file - The document. Only formats translated as a background job
 *   (PDF) are expected here.
 * @param targetLanguage - Document translation language code.
 * @returns The pending job to follow with {@link fetchDocumentJobStatus}.
 * @throws DocumentJobError when the submission is refused; `code` is e.g.
 *   `SERVICE_NOT_CONFIGURED`, and `status` is 429 for an exhausted limit.
 */
export async function submitDocumentTranslation(
  file: File,
  targetLanguage: string,
  signal?: AbortSignal,
): Promise<DocumentTranslationPendingReference> {
  const form = new FormData();
  form.append('document', file);
  form.append('targetLanguage', targetLanguage);
  const response = await fetch('/api/document-translation/translate', {
    method: 'POST',
    body: form,
    signal,
  });
  const data = await dataOf<
    DocumentTranslationPendingReference | DocumentTranslationReference
  >(response, 'Translation failed');
  if (!('async' in data)) {
    // A format translated in one request has no job to follow or pages to
    // read; the workspace only offers this mode for formats that do.
    throw new DocumentJobError(
      'This file type is not translated as a paged document',
      response.status,
      'NOT_A_PAGED_JOB',
    );
  }
  return data;
}

/**
 * Reads where a job stands.
 *
 * @throws DocumentJobError for a transient failure worth retrying.
 */
export async function fetchDocumentJobStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<DocumentJobStatus> {
  const response = await fetch(`/api/document-translation/status/${jobId}`, {
    signal,
  });
  if (response.status === 404) return { status: 'NotFound' };
  const data = await dataOf<{
    status: 'Running' | 'Succeeded' | 'Failed';
    error?: string;
    reference?: DocumentTranslationReference;
  }>(response, 'Could not check the translation');
  if (data.status === 'Succeeded' && data.reference) {
    return { status: 'Succeeded', reference: data.reference };
  }
  if (data.status === 'Failed') {
    return { status: 'Failed', error: data.error ?? 'Translation failed' };
  }
  return { status: 'Running' };
}

/**
 * Reads a window of a job's pages. The server clamps the window to the
 * document and to its per-read maximum, so `to` may come back smaller.
 *
 * The first read of a job builds its page text and can take a while.
 *
 * @param from - First page, 1-based.
 * @param to - Last page requested.
 * @throws DocumentJobError when the pages cannot be read.
 */
export async function fetchDocumentJobPages(
  jobId: string,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<DocumentJobPages> {
  const response = await fetch(
    `/api/document-translation/pages/${jobId}?from=${from}&to=${to}`,
    { signal },
  );
  return dataOf<DocumentJobPages>(response, 'Could not read the pages');
}

/**
 * Saves or removes the correction for one page.
 *
 * @param text - Replacement text, or null to go back to the machine
 *   translation.
 * @returns Every page that has a correction after the change.
 * @throws DocumentJobError when the correction is refused or not saved.
 */
export async function saveDocumentPageCorrection(
  jobId: string,
  page: number,
  text: string | null,
): Promise<number[]> {
  const response = await fetch(`/api/document-translation/pages/${jobId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page, text }),
  });
  const data = await dataOf<{ correctedPages: number[] }>(
    response,
    'Could not save the correction',
  );
  return data.correctedPages;
}

/** URL of a job's translated file, in its original layout. */
export function translatedFileUrl(
  jobId: string,
  filename: string,
  extension: string,
): string {
  return `/api/document-translation/content/${jobId}?filename=${encodeURIComponent(filename)}&ext=${extension}`;
}

/** URL of a job's text version (DOCX), with corrections applied. */
export function textVersionUrl(jobId: string): string {
  return `/api/document-translation/export/${jobId}?format=docx`;
}

/**
 * Downloads a file through the browser's save flow.
 *
 * @param url - Same-origin URL of the file.
 * @param filename - Name to save it under.
 * @throws DocumentJobError when the file cannot be fetched.
 */
export async function downloadFile(
  url: string,
  filename: string,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw await failure(response, 'Download failed');
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}
