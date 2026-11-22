'use client';

import { unwrapApiData } from '@/client/hooks/settings/useAgentAccessAdmin';

import type { BrandBookBody } from '@/lib/utils/shared/brand/brandBook';
import type { DraftGrounding } from '@/lib/utils/shared/brand/draftGrounding';

import type {
  AdminBrandBookResponse,
  AdminBrandBooksResponse,
} from '@/components/AgentAccess/types';

/**
 * The browser's side of brand book administration
 * (app/api/agent-access/brand-books): list, create, update, delete,
 * upload a file, and draft a book from a guide.
 */

const ROUTE = '/api/agent-access/brand-books';

/** A save refused because another admin changed the book first. */
export class BrandBookConflictError extends Error {
  constructor() {
    super('Brand book was modified by another admin');
    this.name = 'BrandBookConflictError';
  }
}

/** Reads `{ success, data }`, or throws the server's message. */
async function dataOf<T>(response: Response, fallback: string): Promise<T> {
  const parsed = await response.json().catch(() => null);
  if (response.status === 409) throw new BrandBookConflictError();
  if (!response.ok || !parsed?.success) {
    const details =
      typeof parsed?.details === 'string' ? `: ${parsed.details}` : '';
    throw new Error(
      `${parsed?.error || `${fallback} (${response.status})`}${details}`,
    );
  }
  return unwrapApiData<T>(parsed);
}

/** Every brand book this admin may edit. */
export async function listAdminBrandBooks(): Promise<AdminBrandBooksResponse> {
  return dataOf(await fetch(ROUTE), 'Could not load brand books');
}

/** Creates a book; its uploads are copied into it. */
export async function createBrandBook(
  book: BrandBookBody,
): Promise<AdminBrandBookResponse> {
  return dataOf(
    await fetch(ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ book }),
    }),
    'Could not create the brand book',
  );
}

/**
 * Saves a book over the version it was read as.
 *
 * @throws BrandBookConflictError when another admin saved it meanwhile.
 */
export async function updateBrandBook(
  id: string,
  book: BrandBookBody,
  etag: string,
): Promise<AdminBrandBookResponse> {
  return dataOf(
    await fetch(ROUTE, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify({ id, book }),
    }),
    'Could not save the brand book',
  );
}

/** Deletes a book and its files. */
export async function deleteBrandBook(id: string, etag: string): Promise<void> {
  const response = await fetch(`${ROUTE}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'If-Match': etag },
  });
  if (!response.ok && response.status !== 404) {
    await dataOf(response, 'Could not delete the brand book');
  }
}

/**
 * Reads a file as the upload route takes it: an image as its whole data
 * URL (the route checks, sanitises and stores it that way), any other
 * file as bare base64.
 */
function asUploadBody(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(
        file.type.startsWith('image/')
          ? result
          : result.slice(result.indexOf(',') + 1),
      );
    };
    reader.onerror = () => reject(reader.error ?? new Error('Read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Uploads a file to the admin's own storage.
 *
 * @returns Its reference (`/api/file/<sha256>.<ext>`), which a save
 *   copies into the book.
 */
export async function uploadBrandFile(file: File): Promise<string> {
  const name = encodeURIComponent(file.name);
  const mime = encodeURIComponent(file.type || 'application/octet-stream');
  const response = await fetch(
    `/api/file/upload?filename=${name}&filetype=file&mime=${mime}`,
    {
      method: 'POST',
      body: await asUploadBody(file),
      headers: { 'x-file-name': name },
    },
  );
  const data = await dataOf<{ uri?: unknown }>(response, 'Upload failed');
  if (typeof data.uri !== 'string') {
    throw new Error('Upload failed: the server gave no file reference');
  }
  return data.uri;
}

/**
 * Uploads a brand guide PDF as its own bytes (the guide route, which takes
 * a larger file than the general upload does).
 *
 * @returns Its reference (`/api/file/<sha256>.pdf`), which drafting reads
 *   and a save copies into the book.
 */
export async function uploadBrandGuide(
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${ROUTE}/guide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: file,
    signal,
  });
  const data = await dataOf<{ file?: unknown }>(
    response,
    'Could not upload the brand guide',
  );
  if (typeof data.file !== 'string') {
    throw new Error('Upload failed: the server gave no file reference');
  }
  return data.file;
}

/** What drafting from a guide returns. */
export interface BrandBookDraft {
  book: BrandBookBody;
  evidence: {
    fonts: Array<{ family: string; share: number }>;
    colors: Array<{ hex: string; share: number }>;
    smallestTextPt: number | null;
    pageCount: number;
  };
  /** Where the guide's text states each drafted value. */
  grounding: DraftGrounding;
  /** The smallest logo width the guide sets, in points; 0 when none. */
  logoMinWidthPt: number;
  /** Entries of the model's answer dropped as unusable. */
  dropped: number;
}

/** Drafts a book from an uploaded guide PDF; nothing is stored. */
export async function draftBrandBookFromGuide(
  file: string,
  name: string,
  signal?: AbortSignal,
): Promise<BrandBookDraft> {
  return dataOf(
    await fetch(`${ROUTE}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, name }),
      signal,
    }),
    'Could not draft a brand book from the guide',
  );
}

/**
 * Where the editor shows a book's file from: the admin file route for a
 * stored file, nothing for an upload not yet saved (the editor shows its
 * local copy).
 */
export function adminBrandFileUrl(ref: string): string | null {
  const match =
    /^admin:(brand-[a-f0-9]{12})\/([a-f0-9]{32}\.[a-z0-9]{2,5})$/.exec(ref);
  if (!match) return null;
  return `${ROUTE}/files?${new URLSearchParams({ id: match[1], name: match[2] })}`;
}
