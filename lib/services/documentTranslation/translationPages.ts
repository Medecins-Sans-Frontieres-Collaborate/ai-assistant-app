/**
 * Page-level text of a translated document, kept server-side.
 *
 * A translated file can be hundreds of pages; its text must never be written
 * into the browser's storage. This module derives the per-page text of the
 * original and the translated file once, caches it as a blob next to the
 * translation, and stores the user's page corrections in a second blob. The
 * UI reads a window of pages at a time and the conversation keeps only the
 * job reference.
 *
 * Blob layout (all under `{userId}/translations/`):
 *   `{jobId}_original.{ext}`     the uploaded file            (translate route)
 *   `{jobId}.{ext}`              the translated file          (status route)
 *   `{jobId}_pages.json`         cached per-page text         (this module)
 *   `{jobId}_corrections.json`   the user's page corrections  (this module)
 *
 * PAGE NUMBER CONVENTION: page numbers are 1-based; `pages[n - 1]` is page
 * `n`, and every page has an entry even when it has no text.
 */
import { BlobProperty, BlobStorage } from '@/lib/utils/server/blob/blob';
import {
  ExtractionOptions,
  extractPdfPageTexts,
  removeTempDir,
} from '@/lib/utils/server/file/fileHandling';

import { supportsPagedText } from '@/types/documentTranslation';

import { TranslationJob } from './translationJobStore';

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Bumped when the cached shape changes; older caches are rebuilt. */
const PAGES_RECORD_VERSION = 1;
const CORRECTIONS_RECORD_VERSION = 1;

/** Largest correction accepted for one page, in characters. */
export const MAX_PAGE_CORRECTION_CHARS = 20_000;

/** Largest number of pages one read may return. */
export const MAX_PAGES_PER_READ = 25;

/** Source and translated text of one page. */
export interface TranslationPageText {
  /** 1-based page number. */
  page: number;
  source: string;
  translation: string;
}

/** Cached per-page text of a translation job. */
export interface TranslationPagesRecord {
  version: number;
  jobId: string;
  pageCount: number;
  /**
   * False when the translated file has a different number of pages than the
   * original, so a page number may not show the same content on both sides.
   */
  pagesAligned: boolean;
  pages: TranslationPageText[];
}

/** The user's replacement text for one translated page. */
export interface PageCorrection {
  text: string;
  /** ISO timestamp of the last save. */
  updatedAt: string;
}

/**
 * A job's corrections, keyed by 1-based page number.
 *
 * A Map, not an object: page numbers arrive from requests and from stored
 * JSON, and a Map key can never reach a property of the object prototype.
 */
export type PageCorrections = Map<number, PageCorrection>;

interface CorrectionsRecord {
  version: number;
  corrections: Record<string, PageCorrection>;
}

/** The job's file format has no page-level text view. */
export class PagedTextUnsupportedError extends Error {
  constructor(extension: string) {
    super(`Page-by-page text is not available for ".${extension}" files`);
    this.name = 'PagedTextUnsupportedError';
  }
}

/** The original or translated file is missing: not finished, or expired. */
export class TranslationFilesMissingError extends Error {
  constructor(which: 'original' | 'translated') {
    super(`The ${which} file is not available: not finished yet, or expired`);
    this.name = 'TranslationFilesMissingError';
  }
}

/** A correction was refused; `message` says which rule it broke. */
export class InvalidCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCorrectionError';
  }
}

function translationBlobPath(job: TranslationJob, suffix: string): string {
  return `${job.userId}/translations/${job.jobId}${suffix}`;
}

async function readBlobIfExists(
  storage: BlobStorage,
  blobPath: string,
): Promise<Buffer | undefined> {
  if (!(await storage.blobExists(blobPath))) return undefined;
  return (await storage.get(blobPath, BlobProperty.BLOB)) as Buffer;
}

async function readJsonBlob<T>(
  storage: BlobStorage,
  blobPath: string,
): Promise<T | undefined> {
  const raw = await readBlobIfExists(storage, blobPath);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    // A truncated or corrupt cache is treated as absent and rebuilt.
    return undefined;
  }
}

async function extractPages(
  file: Buffer,
  workDir: string,
  name: string,
  options?: ExtractionOptions,
): Promise<string[]> {
  // Fixed filename inside a private directory: nothing user-supplied reaches
  // the path or the converter's command line.
  const filePath = path.join(workDir, name);
  await fs.promises.writeFile(filePath, file);
  return extractPdfPageTexts(filePath, options);
}

/**
 * Returns the per-page text of a finished translation, building and caching
 * it on first use.
 *
 * @param storage - The owner's user-data blob storage.
 * @param job - The translation job (already checked to belong to the caller).
 * @param options - Optional abort signal for the text extractors.
 * @returns Every page's source and translated text.
 * @throws PagedTextUnsupportedError for formats without a page view.
 * @throws TranslationFilesMissingError when a file is missing or expired.
 * @throws Error when text extraction fails.
 */
export async function getTranslationPages(
  storage: BlobStorage,
  job: TranslationJob,
  options?: ExtractionOptions,
): Promise<TranslationPagesRecord> {
  if (!supportsPagedText(job.ext)) {
    throw new PagedTextUnsupportedError(job.ext);
  }

  const cachePath = translationBlobPath(job, '_pages.json');
  const cached = await readJsonBlob<TranslationPagesRecord>(storage, cachePath);
  if (cached?.version === PAGES_RECORD_VERSION) return cached;

  const original = await readBlobIfExists(
    storage,
    translationBlobPath(job, `_original.${job.ext}`),
  );
  if (!original) throw new TranslationFilesMissingError('original');
  const translated = await readBlobIfExists(
    storage,
    translationBlobPath(job, `.${job.ext}`),
  );
  if (!translated) throw new TranslationFilesMissingError('translated');

  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'translation-pages-'),
  );
  try {
    const [sourcePages, translatedPages] = await Promise.all([
      extractPages(original, workDir, `source.${job.ext}`, options),
      extractPages(translated, workDir, `translated.${job.ext}`, options),
    ]);
    const pageCount = Math.max(sourcePages.length, translatedPages.length);
    const record: TranslationPagesRecord = {
      version: PAGES_RECORD_VERSION,
      jobId: job.jobId,
      pageCount,
      pagesAligned: sourcePages.length === translatedPages.length,
      pages: Array.from({ length: pageCount }, (_, index) => ({
        page: index + 1,
        source: sourcePages[index] ?? '',
        translation: translatedPages[index] ?? '',
      })),
    };
    await storage.upload(cachePath, JSON.stringify(record), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });
    return record;
  } finally {
    await removeTempDir(workDir);
  }
}

/**
 * Reads the user's corrections for a job.
 *
 * @param storage - The owner's user-data blob storage.
 * @param job - The translation job.
 * @returns Corrections keyed by page number; empty when none were saved.
 */
export async function getPageCorrections(
  storage: BlobStorage,
  job: TranslationJob,
): Promise<PageCorrections> {
  const record = await readJsonBlob<CorrectionsRecord>(
    storage,
    translationBlobPath(job, '_corrections.json'),
  );
  if (record?.version !== CORRECTIONS_RECORD_VERSION) return new Map();
  const corrections: PageCorrections = new Map();
  for (const [key, correction] of Object.entries(record.corrections ?? {})) {
    const page = Number(key);
    // Only keys this module could have written are read back.
    if (Number.isInteger(page) && page >= 1) corrections.set(page, correction);
  }
  return corrections;
}

/**
 * Page numbers that have a correction, ascending.
 *
 * @param corrections - All corrections of the job.
 */
export function correctedPageNumbers(corrections: PageCorrections): number[] {
  return [...corrections.keys()].sort((a, b) => a - b);
}

/**
 * Saves or clears the correction for one page.
 *
 * The whole record is rewritten, so two saves racing from different tabs
 * resolve as last-write-wins; corrections are per user and per job, which
 * keeps that acceptable.
 *
 * @param storage - The owner's user-data blob storage.
 * @param job - The translation job.
 * @param page - 1-based page number, at most `pageCount`.
 * @param text - Replacement text for the page, or `null` to remove the
 *   correction and fall back to the machine translation.
 * @param pageCount - Number of pages in the job, for validation.
 * @returns All corrections after the change.
 * @throws InvalidCorrectionError when the page is out of range or the text
 *   is longer than MAX_PAGE_CORRECTION_CHARS.
 */
export async function savePageCorrection(
  storage: BlobStorage,
  job: TranslationJob,
  page: number,
  text: string | null,
  pageCount: number,
): Promise<PageCorrections> {
  if (!Number.isInteger(page) || page < 1 || page > pageCount) {
    throw new InvalidCorrectionError(
      `Page must be a whole number between 1 and ${pageCount}`,
    );
  }
  if (text !== null && text.length > MAX_PAGE_CORRECTION_CHARS) {
    throw new InvalidCorrectionError(
      `A page correction can be at most ${MAX_PAGE_CORRECTION_CHARS} characters`,
    );
  }

  const corrections = await getPageCorrections(storage, job);
  if (text === null) {
    corrections.delete(page);
  } else {
    corrections.set(page, { text, updatedAt: new Date().toISOString() });
  }
  const record: CorrectionsRecord = {
    version: CORRECTIONS_RECORD_VERSION,
    corrections: Object.fromEntries(corrections),
  };
  await storage.upload(
    translationBlobPath(job, '_corrections.json'),
    JSON.stringify(record),
    { blobHTTPHeaders: { blobContentType: 'application/json' } },
  );
  return corrections;
}

/**
 * The text to show or export for a page: the user's correction when one
 * exists, otherwise the machine translation.
 *
 * @param page - The page's text.
 * @param corrections - All corrections of the job.
 */
export function effectiveTranslation(
  page: TranslationPageText,
  corrections: PageCorrections,
): string {
  return corrections.get(page.page)?.text ?? page.translation;
}
