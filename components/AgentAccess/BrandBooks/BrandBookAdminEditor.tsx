'use client';

import { IconArrowLeft, IconLoader } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';
import Link from 'next/link';

import {
  BrandBookConflictError,
  BrandBookDraft,
  adminBrandFileUrl,
  draftBrandBookFromGuide,
  listAdminBrandBooks,
  updateBrandBook,
  uploadBrandFile,
} from '@/client/services/brand/brandBookAdmin';

import {
  BrandBookBody,
  parseBrandBookBody,
} from '@/lib/utils/shared/brand/brandBook';

import {
  BrandFileAccess,
  LanguageSection,
  LogosSection,
  PaletteSection,
  TemplatesSection,
  TypographySection,
  UploadButton,
} from './BrandBookSections';
import { EditorSection, Field, inputClass } from './brandEditorControls';

/*
 * State holds what happened, never translated text: `useTranslations`
 * may hand back a new `t` on every render, and a callback depending on it
 * re-ran the load effect on every render, forever. Text is made at render.
 */
type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string | null }
  | { phase: 'missing' }
  | { phase: 'loaded' };

const primaryClass =
  'inline-flex min-h-[32px] items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-40';
const secondaryClass =
  'inline-flex min-h-[32px] items-center rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-800 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800';

/** What the editor last told the admin, as data; worded at render. */
type Notice =
  | { kind: 'saved' }
  | { kind: 'invalid'; reason: string }
  | {
      kind: 'error';
      /** The server's or browser's message, when there is one. */
      text: string | null;
      fallback: 'saveFailed' | 'guide.failed';
    };

/** Most measured fonts and colours the draft note shows. */
const EVIDENCE_SHOWN = 6;

/**
 * Full-page editor for one brand book (docs/DOCUMENT_PLATFORM.md, phase E):
 * its colours, type, logos, language and templates, a draft from a brand
 * guide PDF, and a CAS save with If-Match (a 409 shows the conflict
 * banner). Ctrl/Cmd+S saves; leaving with unsaved changes asks first.
 */
export function BrandBookAdminEditor({ bookId }: { bookId: string }) {
  const t = useTranslations('adminBrandBooks');
  const queryClient = useQueryClient();

  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const [book, setBook] = useState<BrandBookBody | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [etag, setEtag] = useState('');
  const [saving, setSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [message, setMessage] = useState<Notice | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<{
    evidence: BrandBookDraft['evidence'];
    before: BrandBookBody;
  } | null>(null);

  // Local copies of files uploaded since loading, shown until saved.
  const localPreviews = useRef(new Map<string, string>());
  useEffect(() => {
    const previews = localPreviews.current;
    return () => {
      for (const url of previews.values()) URL.revokeObjectURL(url);
    };
  }, []);

  const dirty = book !== null && JSON.stringify(book) !== savedJson;

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    setIsConflict(false);
    try {
      const data = await listAdminBrandBooks();
      const entry = data.books.find((b) => b.record.id === bookId);
      if (!entry) {
        setState({ phase: 'missing' });
        return;
      }
      setBook(entry.record.book);
      setSavedJson(JSON.stringify(entry.record.book));
      setEtag(entry.etag);
      setDraft(null);
      setState({ phase: 'loaded' });
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : null,
      });
    }
  }, [bookId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    // The shortcut follows the button: nothing to save, no request.
    if (!book || saving || !dirty) return;
    setMessage(null);
    const parsed = parseBrandBookBody(book);
    if (!parsed.ok) {
      setMessage({ kind: 'invalid', reason: parsed.error });
      return;
    }
    setSaving(true);
    try {
      const result = await updateBrandBook(bookId, parsed.body, etag);
      setBook(result.record.book);
      setSavedJson(JSON.stringify(result.record.book));
      setEtag(result.etag);
      setDraft(null);
      setMessage({ kind: 'saved' });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['agent-access-brand-books'],
        }),
        queryClient.invalidateQueries({ queryKey: ['brand-books'] }),
      ]);
    } catch (error) {
      if (error instanceof BrandBookConflictError) {
        setIsConflict(true);
      } else {
        setMessage({
          kind: 'error',
          text: error instanceof Error ? error.message : null,
          fallback: 'saveFailed',
        });
      }
    } finally {
      setSaving(false);
    }
  }, [book, bookId, dirty, etag, queryClient, saving]);

  // Ctrl/Cmd+S saves rather than saving the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const files = useMemo<BrandFileAccess>(
    () => ({
      upload: async (file: File) => {
        const ref = await uploadBrandFile(file);
        localPreviews.current.set(ref, URL.createObjectURL(file));
        return ref;
      },
      previewUrl: (ref: string) =>
        localPreviews.current.get(ref) ?? adminBrandFileUrl(ref),
    }),
    [],
  );

  const change = (next: BrandBookBody) => {
    setMessage(null);
    setBook(next);
  };
  const showError = (text: string) =>
    setMessage({ kind: 'error', text, fallback: 'saveFailed' });

  const draftFromGuide = async (file: File) => {
    if (!book) return;
    if (!/\.pdf$/i.test(file.name)) {
      showError(t('guide.notPdf'));
      return;
    }
    setDrafting(true);
    setMessage(null);
    try {
      const ref = await uploadBrandFile(file);
      const result = await draftBrandBookFromGuide(ref, file.name);
      // The guide's rules replace the book's; its files stay the admin's.
      setBook({
        ...result.book,
        logos: book.logos,
        templates: book.templates,
      });
      setDraft({ evidence: result.evidence, before: book });
    } catch (error) {
      setMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : null,
        fallback: 'guide.failed',
      });
    } finally {
      setDrafting(false);
    }
  };

  if (state.phase === 'loading') {
    return (
      <p className="p-6 text-sm text-gray-500 dark:text-gray-400" role="status">
        {t('loading')}
      </p>
    );
  }
  if (state.phase !== 'loaded' || !book) {
    return (
      <div className="p-6 text-sm">
        <p className="text-red-600 dark:text-red-400" role="alert">
          {state.phase === 'error'
            ? (state.message ?? t('loadFailed'))
            : t('missing')}
        </p>
        <Link href="/admin/brand-books" className={`${secondaryClass} mt-3`}>
          {t('back')}
        </Link>
      </div>
    );
  }

  const sourceUrl = book.source ? files.previewUrl(book.source.file) : null;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 sm:px-6">
      <header className="sticky top-0 z-10 -mx-4 mb-6 flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white/95 px-4 py-3 backdrop-blur-sm dark:border-gray-800 dark:bg-surface-dark/95 sm:-mx-6 sm:px-6">
        <Link
          href="/admin/brand-books"
          className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 text-sm text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <IconArrowLeft size={16} aria-hidden />
          {t('back')}
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-gray-900 dark:text-gray-100">
          {book.name || t('untitled')}
        </h1>
        <span
          className="text-xs text-gray-500 dark:text-gray-400"
          aria-live="polite"
        >
          {dirty ? t('unsaved') : message?.kind === 'saved' ? t('saved') : ''}
        </span>
        <button
          type="button"
          className={primaryClass}
          disabled={!dirty || saving}
          aria-keyshortcuts="Control+S Meta+S"
          onClick={() => void save()}
        >
          {saving && (
            <IconLoader size={14} className="animate-spin" aria-hidden />
          )}
          {t('save')}
        </button>
      </header>

      {isConflict && (
        <div
          className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200"
          role="alert"
        >
          <p>{t('conflict')}</p>
          <button
            type="button"
            className={`${secondaryClass} mt-2`}
            onClick={() => void load()}
          >
            {t('reload')}
          </button>
        </div>
      )}
      {(message?.kind === 'error' || message?.kind === 'invalid') && (
        <p
          className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300"
          role="alert"
        >
          {message.kind === 'invalid'
            ? t('invalid', { reason: message.reason })
            : (message.text ?? t(message.fallback))}
        </p>
      )}

      <div className="divide-y divide-gray-200 dark:divide-gray-800">
        <EditorSection
          title={t('basics.title')}
          action={
            <UploadButton
              accept=".pdf"
              label={drafting ? t('guide.reading') : t('guide.action')}
              onFile={draftFromGuide}
            />
          }
        >
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label={t('basics.name')}>
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  value={book.name}
                  maxLength={100}
                  onChange={(event) =>
                    change({ ...book, name: event.target.value })
                  }
                />
              )}
            </Field>
            <Field label={t('basics.description')}>
              {(id) => (
                <input
                  id={id}
                  className={inputClass}
                  value={book.description}
                  maxLength={1000}
                  onChange={(event) =>
                    change({ ...book, description: event.target.value })
                  }
                />
              )}
            </Field>
          </div>
          <p className="mt-3 max-w-2xl text-xs text-gray-500 dark:text-gray-400">
            {t('guide.hint')}
          </p>
          {book.source && (
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
              {t('guide.source')}{' '}
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 underline underline-offset-2 hover:text-blue-800 dark:text-blue-400"
                >
                  {book.source.name}
                </a>
              ) : (
                book.source.name
              )}
            </p>
          )}
          {draft && (
            <div
              className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-100"
              role="status"
            >
              <p className="font-medium">
                {t('guide.applied', { pages: draft.evidence.pageCount })}
              </p>
              {draft.evidence.fonts.length > 0 && (
                <p className="mt-1">
                  {t('guide.measuredFonts')}{' '}
                  {draft.evidence.fonts
                    .slice(0, EVIDENCE_SHOWN)
                    .map((f) => `${f.family} ${Math.round(f.share * 100)}%`)
                    .join(', ')}
                </p>
              )}
              {draft.evidence.colors.length > 0 && (
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {t('guide.measuredColors')}
                  {draft.evidence.colors.slice(0, EVIDENCE_SHOWN).map((c) => (
                    <span
                      key={c.hex}
                      className="inline-flex items-center gap-1"
                    >
                      <span
                        aria-hidden
                        className="h-3 w-3 rounded-sm border border-blue-300"
                        style={{ backgroundColor: c.hex }}
                      />
                      <span className="font-mono text-xs">{c.hex}</span>
                    </span>
                  ))}
                </p>
              )}
              <p className="mt-2 text-xs">{t('guide.check')}</p>
              <button
                type="button"
                className={`${secondaryClass} mt-2`}
                onClick={() => {
                  setBook(draft.before);
                  setDraft(null);
                }}
              >
                {t('guide.undo')}
              </button>
            </div>
          )}
        </EditorSection>
        <PaletteSection book={book} onChange={change} />
        <TypographySection book={book} onChange={change} />
        <LogosSection
          book={book}
          onChange={change}
          files={files}
          onError={showError}
        />
        <LanguageSection book={book} onChange={change} />
        <TemplatesSection
          book={book}
          onChange={change}
          files={files}
          onError={showError}
        />
      </div>
    </div>
  );
}
