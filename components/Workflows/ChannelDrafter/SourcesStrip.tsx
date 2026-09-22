'use client';

import {
  IconAlertTriangle,
  IconBrandOnedrive,
  IconFileText,
  IconLink,
  IconNote,
  IconPlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { DraftSource } from '@/types/drafter';

import {
  Popover,
  iconButton,
  menuItem,
} from '@/components/Workflows/Shared/Drafter/Popover';

const KIND_ICON = {
  file: IconFileText,
  url: IconLink,
  search: IconSearch,
  note: IconNote,
  m365: IconFileText,
} as const;

const fieldClass =
  'min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400';

export interface SourcesStripProps {
  sources: DraftSource[];
  busy: boolean;
  onAddFile: (file: File) => void;
  onAddUrl: (url: string) => void;
  onAddNote: (text: string) => void;
  /** Absent = M365 files not enabled/connected for this user. */
  onAddFromM365?: () => void;
  onRemove: (sourceId: string) => void;
}

/**
 * The sources a brief is made from, as one line at the top of the brief
 * pane: a source feeds the brief, so it sits beside it rather than in a bar
 * of its own. Adding is one `+` with the four ways behind it.
 */
export function SourcesStrip(props: SourcesStripProps) {
  const t = useTranslations('workflows.form');
  const tDrafter = useTranslations('workflows.drafter');
  const fileInput = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<'none' | 'url' | 'note'>('none');
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (mode === 'url') props.onAddUrl(text);
    else props.onAddNote(text);
    setDraft('');
    setMode('none');
  };

  return (
    <div className="border-b border-gray-200 px-2 py-1.5 dark:border-gray-700">
      <div className="flex items-center gap-1">
        <span className="shrink-0 px-1 text-xs font-medium text-gray-600 dark:text-gray-400">
          {tDrafter('sourcesCount', { count: props.sources.length })}
        </span>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {props.sources.map((source) => {
            const Icon = KIND_ICON[source.kind] ?? IconFileText;
            return (
              <span
                key={source.id}
                className="inline-flex max-w-[200px] shrink-0 items-center gap-1 rounded-lg border border-gray-300 bg-gray-50 px-1.5 py-0.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-300"
                title={source.url ?? source.name}
              >
                <Icon size={12} aria-hidden className="shrink-0" />
                <span className="truncate">{source.name}</span>
                {source.error && (
                  <IconAlertTriangle
                    size={12}
                    aria-label={t('sourceFailed')}
                    className="shrink-0 text-amber-600 dark:text-amber-400"
                  />
                )}
                <button
                  type="button"
                  onClick={() => props.onRemove(source.id)}
                  disabled={props.busy}
                  aria-label={t('removeSource')}
                  className="shrink-0 rounded text-gray-500 hover:text-gray-900 disabled:opacity-30 dark:hover:text-gray-100"
                >
                  <IconX size={12} aria-hidden />
                </button>
              </span>
            );
          })}
        </div>
        <input
          ref={fileInput}
          type="file"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) props.onAddFile(file);
            event.target.value = '';
          }}
        />
        <span className="relative">
          <button
            type="button"
            className={iconButton}
            aria-label={tDrafter('addSource')}
            title={tDrafter('addSource')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            disabled={props.busy}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <IconPlus size={16} aria-hidden />
          </button>
          <Popover
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            placement="below-end"
          >
            <div role="menu" className="flex flex-col">
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  fileInput.current?.click();
                }}
              >
                <IconFileText size={14} aria-hidden />
                {t('addFile')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  setMode('url');
                }}
              >
                <IconLink size={14} aria-hidden />
                {t('addUrl')}
              </button>
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  setMode('note');
                }}
              >
                <IconNote size={14} aria-hidden />
                {t('addNote')}
              </button>
              {props.onAddFromM365 && (
                <button
                  type="button"
                  role="menuitem"
                  className={menuItem}
                  onClick={() => {
                    setMenuOpen(false);
                    props.onAddFromM365?.();
                  }}
                >
                  <IconBrandOnedrive size={14} aria-hidden />
                  {t('addFromOneDrive')}
                </button>
              )}
            </div>
          </Popover>
        </span>
      </div>
      {mode !== 'none' && (
        <form
          className="mt-1.5 flex items-start gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {mode === 'url' ? (
            <input
              type="url"
              autoFocus
              value={draft}
              className={fieldClass}
              placeholder={t('urlPlaceholder')}
              aria-label={t('addUrl')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setMode('none');
              }}
            />
          ) : (
            <textarea
              autoFocus
              rows={3}
              value={draft}
              className={fieldClass}
              placeholder={t('notePlaceholder')}
              aria-label={t('addNote')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setMode('none');
              }}
            />
          )}
          <button
            type="submit"
            disabled={props.busy || !draft.trim()}
            className="shrink-0 rounded-lg bg-gray-200 px-2 py-1 text-xs font-medium text-gray-900 hover:bg-gray-300 disabled:opacity-30 dark:bg-surface-dark-elevated dark:text-white"
          >
            {tDrafter('add')}
          </button>
        </form>
      )}
    </div>
  );
}
