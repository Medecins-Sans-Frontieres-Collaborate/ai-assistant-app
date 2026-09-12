'use client';

import {
  IconAlertTriangle,
  IconBrandOnedrive,
  IconFileText,
  IconLink,
  IconNote,
  IconSearch,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { FillSourceRecord } from '@/types/formFill';

interface SourcesBarProps {
  sources: FillSourceRecord[];
  documentLanguage?: string;
  busy: boolean;
  onAddFile: (file: File) => void;
  onAddUrl: (url: string) => void;
  onAddNote: (text: string) => void;
  /** Absent = web search unavailable (no provider or workflow gate). */
  onSearch?: (query: string) => void;
  /** Absent = M365 files not enabled/connected for this user. */
  onAddFromM365?: () => void;
  onRemove: (sourceId: string) => void;
  /** Suggested query for the search box (template name + open fields). */
  suggestedQuery?: string;
}

const KIND_ICON = {
  file: IconFileText,
  url: IconLink,
  search: IconSearch,
  note: IconNote,
  m365: IconFileText,
} as const;

const chipClass =
  'inline-flex max-w-[260px] items-center gap-1.5 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300';
const buttonClass =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-400 dark:hover:bg-surface-dark-elevated';
const inputClass =
  'min-w-0 flex-1 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

/**
 * The sources strip: files, links, notes (and later searches) the fill run
 * reads from. Adding a source never auto-fills — the user runs Fill, so
 * spend stays predictable, matching every other workflow.
 */
export function SourcesBar({
  sources,
  documentLanguage,
  busy,
  onAddFile,
  onAddUrl,
  onAddNote,
  onSearch,
  onAddFromM365,
  onRemove,
  suggestedQuery,
}: SourcesBarProps) {
  const t = useTranslations('workflows.form');
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'none' | 'url' | 'note' | 'search'>('none');
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (mode === 'url') onAddUrl(text);
    else if (mode === 'search') onSearch?.(text);
    else onAddNote(text);
    setDraft('');
    setMode('none');
  };

  const foreign = sources.filter(
    (s) =>
      s.language &&
      documentLanguage &&
      s.language.toLowerCase() !== documentLanguage.toLowerCase(),
  );

  return (
    <div className="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {t('sources')}
        </span>
        {sources.map((source) => {
          const Icon = KIND_ICON[source.kind] ?? IconFileText;
          return (
            <span
              key={source.id}
              className={chipClass}
              title={source.url ?? source.name}
            >
              <Icon size={12} aria-hidden className="shrink-0" />
              <span className="truncate">{source.name}</span>
              {source.language && (
                <span className="shrink-0 text-[10px] text-gray-500 dark:text-gray-400">
                  {source.language}
                </span>
              )}
              {source.error && (
                <IconAlertTriangle
                  size={12}
                  aria-label={t('sourceFailed')}
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                />
              )}
              <button
                type="button"
                onClick={() => onRemove(source.id)}
                disabled={busy}
                aria-label={t('removeSource')}
                className="shrink-0 rounded text-gray-500 hover:text-gray-900 disabled:opacity-30 dark:hover:text-gray-100"
              >
                <IconX size={12} aria-hidden />
              </button>
            </span>
          );
        })}
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAddFile(file);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
          className={buttonClass}
        >
          <IconUpload size={13} aria-hidden />
          {t('addFile')}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === 'url' ? 'none' : 'url')}
          disabled={busy}
          aria-pressed={mode === 'url'}
          className={buttonClass}
        >
          <IconLink size={13} aria-hidden />
          {t('addUrl')}
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === 'note' ? 'none' : 'note')}
          disabled={busy}
          aria-pressed={mode === 'note'}
          className={buttonClass}
        >
          <IconNote size={13} aria-hidden />
          {t('addNote')}
        </button>
        {onSearch && (
          <button
            type="button"
            onClick={() => {
              if (mode !== 'search' && suggestedQuery && !draft) {
                setDraft(suggestedQuery);
              }
              setMode(mode === 'search' ? 'none' : 'search');
            }}
            disabled={busy}
            aria-pressed={mode === 'search'}
            className={buttonClass}
          >
            <IconSearch size={13} aria-hidden />
            {t('addSearch')}
          </button>
        )}
        {onAddFromM365 && (
          <button
            type="button"
            onClick={onAddFromM365}
            disabled={busy}
            className={buttonClass}
          >
            <IconBrandOnedrive size={13} aria-hidden />
            {t('addFromOneDrive')}
          </button>
        )}
      </div>
      {mode !== 'none' && (
        <div className="mt-2 flex items-start gap-2">
          {mode === 'url' || mode === 'search' ? (
            <input
              type={mode === 'url' ? 'url' : 'text'}
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
                if (e.key === 'Escape') setMode('none');
              }}
              placeholder={
                mode === 'url' ? t('urlPlaceholder') : t('searchPlaceholder')
              }
              className={inputClass}
            />
          ) : (
            <textarea
              value={draft}
              autoFocus
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setMode('none');
              }}
              placeholder={t('notePlaceholder')}
              className={inputClass}
            />
          )}
          <button
            type="button"
            onClick={submit}
            disabled={busy || !draft.trim()}
            className="shrink-0 rounded-lg bg-gray-300 px-2 py-1 text-xs font-medium text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark-base dark:text-white dark:hover:bg-surface-dark-elevated"
          >
            {mode === 'search' ? t('searchAction') : t('addNoteAction')}
          </button>
        </div>
      )}
      {foreign.length > 0 && documentLanguage && (
        <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
          {t('sourceLanguageNotice', {
            source: [...new Set(foreign.map((s) => s.language))].join(', '),
            document: documentLanguage,
          })}
        </p>
      )}
    </div>
  );
}
