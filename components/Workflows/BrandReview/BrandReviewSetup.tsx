'use client';

import { IconFileUpload, IconLoader } from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { uploadBrandFile } from '@/client/services/brand/brandBookAdmin';
import { UsableBrandBook } from '@/client/services/brand/brandReview';

/** File types a review reads (REVIEWABLE_TYPES on the server). */
export const REVIEW_ACCEPT =
  '.pdf,.docx,.doc,.odt,.rtf,.pptx,.pptm,.ppsx,.potx,.ppt,.pps,.pot,.odp';

/** The document chosen, as the workflow keeps it. */
export interface ReviewDocument {
  file: string;
  name: string;
  type: string;
}

/**
 * Choosing what to review: a brand book the person may use, a document,
 * and whether a model looks at each page. Starting is the container's.
 */
export function BrandReviewSetup({
  books,
  booksLoading,
  bookId,
  onBook,
  document,
  onDocument,
  modelReview,
  onModelReview,
  onStart,
  starting,
  error,
}: {
  books: UsableBrandBook[];
  booksLoading: boolean;
  bookId: string | undefined;
  onBook: (id: string) => void;
  document: ReviewDocument | undefined;
  onDocument: (document: ReviewDocument) => void;
  modelReview: boolean;
  onModelReview: (on: boolean) => void;
  onStart: () => void;
  starting: boolean;
  error: string | null;
}) {
  const t = useTranslations('workflows.brandReview');
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const choose = async (file: File) => {
    const type = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
    if (!REVIEW_ACCEPT.split(',').includes(`.${type}`)) {
      setUploadError(t('setup.wrongType'));
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      onDocument({ file: await uploadBrandFile(file), name: file.name, type });
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : t('setup.uploadFailed'),
      );
    } finally {
      setUploading(false);
    }
  };

  const heading = 'mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100';

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-8 sm:px-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('setup.title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('setup.intro')}
        </p>
      </div>

      <fieldset>
        <legend className={heading}>{t('setup.book')}</legend>
        {booksLoading ? (
          <p className="text-sm text-gray-500" role="status">
            {t('setup.booksLoading')}
          </p>
        ) : books.length === 0 ? (
          <p className="rounded-md border border-dashed border-gray-300 p-4 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
            {t('setup.noBooks')}
          </p>
        ) : (
          <div className="space-y-1.5">
            {books.map((book) => (
              <label
                key={book.id}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600 ${
                  bookId === book.id
                    ? 'border-blue-500 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30'
                    : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
                }`}
              >
                <input
                  type="radio"
                  name="brand-book"
                  className="sr-only"
                  checked={bookId === book.id}
                  onChange={() => onBook(book.id)}
                />
                <span className="flex shrink-0 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
                  {book.colors.slice(0, 6).map((hex) => (
                    <span
                      key={hex}
                      aria-hidden
                      className="h-6 w-3"
                      style={{ backgroundColor: hex }}
                    />
                  ))}
                  {book.colors.length === 0 && (
                    <span
                      aria-hidden
                      className="h-6 w-6 bg-gray-100 dark:bg-gray-800"
                    />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                    {book.name}
                  </span>
                  {book.description && (
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                      {book.description}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div>
        <h3 className={heading}>{t('setup.document')}</h3>
        <input
          ref={input}
          type="file"
          accept={REVIEW_ACCEPT}
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void choose(file);
          }}
        />
        <button
          type="button"
          onClick={() => input.current?.click()}
          disabled={uploading}
          aria-busy={uploading}
          className="flex w-full items-center gap-3 rounded-lg border border-dashed border-gray-300 p-4 text-start hover:border-gray-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-60 dark:border-gray-700 dark:hover:border-gray-500"
        >
          {uploading ? (
            <IconLoader
              size={20}
              className="animate-spin text-gray-500"
              aria-hidden
            />
          ) : (
            <IconFileUpload size={20} className="text-gray-500" aria-hidden />
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {uploading
                ? t('setup.uploading')
                : (document?.name ?? t('setup.chooseDocument'))}
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {document ? t('setup.replaceDocument') : t('setup.documentTypes')}
            </span>
          </span>
        </button>
        {uploadError && (
          <p
            className="mt-2 text-sm text-red-600 dark:text-red-400"
            role="alert"
          >
            {uploadError}
          </p>
        )}
      </div>

      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={modelReview}
          onChange={(event) => onModelReview(event.target.checked)}
        />
        <span>
          <span className="block text-sm text-gray-900 dark:text-gray-100">
            {t('setup.modelReview')}
          </span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            {t('setup.modelReviewHint')}
          </span>
        </span>
      </label>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onStart}
        disabled={!bookId || !document || starting || uploading}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-40"
      >
        {starting && (
          <IconLoader size={14} className="animate-spin" aria-hidden />
        )}
        {t('setup.start')}
      </button>
    </div>
  );
}
