'use client';

import {
  IconFileUpload,
  IconLoader,
  IconPhoto,
  IconX,
} from '@tabler/icons-react';
import { ReactNode, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { uploadBrandFile } from '@/client/services/brand/brandBookAdmin';
import { UsableBrandBook } from '@/client/services/brand/brandReview';

import { getAutonym, getSupportedLocales } from '@/lib/utils/app/locales';

import { DeckBuilderUpload, DeckBuilderWorkflowState } from '@/types/workflow';

/** Types each upload takes (DECK_*_TYPES on the server). */
const TEMPLATE_ACCEPT = '.pptx,.potx';
const SOURCE_ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.csv';
const PICTURE_ACCEPT = '.png,.jpg,.jpeg,.gif';
const MAX_SOURCES = 5;
const MAX_PICTURES = 10;

const extensionOf = (name: string) =>
  /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';

const heading = 'mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100';
const hint = 'text-xs text-gray-500 dark:text-gray-400';
const cardBase =
  'flex cursor-pointer items-center gap-3 rounded-lg border p-3 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-600';
const cardChosen =
  'border-blue-500 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30';
const cardIdle =
  'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600';

/** What the setup changes in the conversation's state. */
type SetupChanges = Partial<
  Pick<
    DeckBuilderWorkflowState,
    'bookId' | 'template' | 'brief' | 'sources' | 'pictures' | 'language'
  >
>;

/** Uploads a file the person picked, saying when it is the wrong type. */
function useUpload(accept: string, wrongType: string, failed: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = async (file: File): Promise<DeckBuilderUpload | null> => {
    if (!accept.split(',').includes(`.${extensionOf(file.name)}`)) {
      setError(wrongType);
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      return { file: await uploadBrandFile(file), name: file.name };
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, upload };
}

/** A hidden file input opened by a visible button. */
function UploadButton({
  accept,
  multiple,
  busy,
  disabled,
  icon,
  label,
  detail,
  onFiles,
}: {
  accept: string;
  multiple?: boolean;
  busy: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  detail: string;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={busy || disabled}
        aria-busy={busy}
        className="flex w-full items-center gap-3 rounded-lg border border-dashed border-gray-300 p-3 text-start hover:border-gray-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-60 dark:border-gray-700 dark:hover:border-gray-500"
      >
        {busy ? (
          <IconLoader
            size={20}
            className="animate-spin text-gray-500"
            aria-hidden
          />
        ) : (
          icon
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {label}
          </span>
          <span className={`block ${hint}`}>{detail}</span>
        </span>
      </button>
    </>
  );
}

/** Uploaded files, each removable. */
function UploadList({
  uploads,
  removeLabel,
  onRemove,
}: {
  uploads: readonly DeckBuilderUpload[];
  removeLabel: (name: string) => string;
  onRemove: (file: string) => void;
}) {
  if (uploads.length === 0) return null;
  return (
    <ul className="mb-2 space-y-1">
      {uploads.map((upload) => (
        <li
          key={upload.file}
          className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-1.5 text-sm text-gray-800 dark:bg-gray-800/60 dark:text-gray-200"
        >
          <span className="min-w-0 flex-1 truncate">{upload.name}</span>
          <button
            type="button"
            aria-label={removeLabel(upload.name)}
            onClick={() => onRemove(upload.file)}
            className="rounded p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:bg-gray-700 dark:hover:text-gray-100"
          >
            <IconX size={14} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a deck is made from: a template (a brand book's, or the person's
 * own), what it is for, sources to draw on, pictures it may use, and the
 * language it is written in. Starting the outline is the container's.
 */
export function DeckSetup({
  ws,
  books,
  booksLoading,
  uiLocale,
  onChange,
  onStart,
  starting,
  error,
}: {
  ws: DeckBuilderWorkflowState;
  books: UsableBrandBook[];
  booksLoading: boolean;
  uiLocale: string;
  onChange: (changes: SetupChanges) => void;
  onStart: () => void;
  starting: boolean;
  error: string | null;
}) {
  const t = useTranslations('workflows.deckBuilder.setup');
  const template = useUpload(
    TEMPLATE_ACCEPT,
    t('wrongType'),
    t('uploadFailed'),
  );
  const sources = useUpload(SOURCE_ACCEPT, t('wrongType'), t('uploadFailed'));
  const pictures = useUpload(PICTURE_ACCEPT, t('wrongType'), t('uploadFailed'));

  const bookTemplates = books.flatMap((book) =>
    book.templates.map((item) => ({ book, template: item })),
  );
  const ownTemplate =
    ws.template && !ws.template.file.startsWith('admin:') ? ws.template : null;
  const language = ws.language ?? uiLocale;
  const canStart =
    !!ws.template &&
    ws.brief.trim().length > 0 &&
    !starting &&
    !template.busy &&
    !sources.busy &&
    !pictures.busy;

  const addUploads = async (
    files: File[],
    upload: (file: File) => Promise<DeckBuilderUpload | null>,
    current: readonly DeckBuilderUpload[],
    max: number,
  ): Promise<DeckBuilderUpload[]> => {
    const added: DeckBuilderUpload[] = [];
    for (const file of files.slice(0, Math.max(max - current.length, 0))) {
      const done = await upload(file);
      if (done && !current.some((item) => item.file === done.file)) {
        added.push(done);
      }
    }
    return [...current, ...added];
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4 py-8 sm:px-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('intro')}
        </p>
      </div>

      <fieldset>
        <legend className={heading}>{t('template')}</legend>
        <div className="space-y-1.5">
          {booksLoading && (
            <p className={hint} role="status">
              {t('booksLoading')}
            </p>
          )}
          {bookTemplates.map(({ book, template: item }) => (
            <label
              key={`${book.id}:${item.id}`}
              className={`${cardBase} ${ws.template?.file === item.file ? cardChosen : cardIdle}`}
            >
              <input
                type="radio"
                name="deck-template"
                className="sr-only"
                checked={ws.template?.file === item.file}
                onChange={() =>
                  onChange({
                    bookId: book.id,
                    template: {
                      file: item.file,
                      name: item.name,
                      type: item.type,
                    },
                  })
                }
              />
              <span className="flex shrink-0 overflow-hidden rounded border border-gray-200 dark:border-gray-700">
                {book.colors.slice(0, 4).map((hex) => (
                  <span
                    key={hex}
                    aria-hidden
                    className="h-6 w-2.5"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {item.name}
                </span>
                <span className={`block truncate ${hint}`}>
                  {t('fromBook', { book: book.name })}
                </span>
              </span>
            </label>
          ))}
          <UploadButton
            accept={TEMPLATE_ACCEPT}
            busy={template.busy}
            icon={
              <IconFileUpload size={20} className="text-gray-500" aria-hidden />
            }
            label={ownTemplate?.name ?? t('ownTemplate')}
            detail={ownTemplate ? t('replaceTemplate') : t('templateTypes')}
            onFiles={async ([file]) => {
              const done = await template.upload(file);
              if (done) {
                onChange({
                  bookId: undefined,
                  template: { ...done, type: extensionOf(done.name) },
                });
              }
            }}
          />
          {template.error && (
            <p className="text-sm text-red-600 dark:text-red-400" role="alert">
              {template.error}
            </p>
          )}
        </div>
        {ownTemplate && books.length > 0 && (
          <label className="mt-3 block">
            <span className={heading}>{t('checkAgainst')}</span>
            <select
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              value={ws.bookId ?? ''}
              onChange={(event) =>
                onChange({ bookId: event.target.value || undefined })
              }
            >
              <option value="">{t('noBook')}</option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </fieldset>

      <label className="block">
        <span className={heading}>{t('brief')}</span>
        <textarea
          className="mt-1 block min-h-[120px] w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          placeholder={t('briefPlaceholder')}
          value={ws.brief}
          maxLength={8000}
          onChange={(event) => onChange({ brief: event.target.value })}
        />
      </label>

      <div>
        <h3 className={heading}>{t('sources')}</h3>
        <UploadList
          uploads={ws.sources}
          removeLabel={(name) => t('remove', { name })}
          onRemove={(file) =>
            onChange({
              sources: ws.sources.filter((item) => item.file !== file),
            })
          }
        />
        <UploadButton
          accept={SOURCE_ACCEPT}
          multiple
          busy={sources.busy}
          disabled={ws.sources.length >= MAX_SOURCES}
          icon={
            <IconFileUpload size={20} className="text-gray-500" aria-hidden />
          }
          label={t('addSources')}
          detail={t('sourceTypes', { max: MAX_SOURCES })}
          onFiles={async (files) =>
            onChange({
              sources: await addUploads(
                files,
                sources.upload,
                ws.sources,
                MAX_SOURCES,
              ),
            })
          }
        />
        {sources.error && (
          <p
            className="mt-2 text-sm text-red-600 dark:text-red-400"
            role="alert"
          >
            {sources.error}
          </p>
        )}
      </div>

      <div>
        <h3 className={heading}>{t('pictures')}</h3>
        <UploadList
          uploads={ws.pictures}
          removeLabel={(name) => t('remove', { name })}
          onRemove={(file) =>
            onChange({
              pictures: ws.pictures.filter((item) => item.file !== file),
            })
          }
        />
        <UploadButton
          accept={PICTURE_ACCEPT}
          multiple
          busy={pictures.busy}
          disabled={ws.pictures.length >= MAX_PICTURES}
          icon={<IconPhoto size={20} className="text-gray-500" aria-hidden />}
          label={t('addPictures')}
          detail={t('pictureTypes', { max: MAX_PICTURES })}
          onFiles={async (files) =>
            onChange({
              pictures: await addUploads(
                files,
                pictures.upload,
                ws.pictures,
                MAX_PICTURES,
              ),
            })
          }
        />
        {pictures.error && (
          <p
            className="mt-2 text-sm text-red-600 dark:text-red-400"
            role="alert"
          >
            {pictures.error}
          </p>
        )}
      </div>

      <label className="block">
        <span className={heading}>{t('language')}</span>
        <select
          className="mt-1 block w-full max-w-xs rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          value={language}
          onChange={(event) => onChange({ language: event.target.value })}
        >
          {getSupportedLocales().map((locale) => (
            <option key={locale} value={locale}>
              {getAutonym(locale)}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onStart}
        disabled={!canStart}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-40"
      >
        {starting && (
          <IconLoader size={14} className="animate-spin" aria-hidden />
        )}
        {t('start')}
      </button>
    </div>
  );
}
