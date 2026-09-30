'use client';

import { IconArrowLeft, IconExternalLink } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { getSourceText } from '@/client/services/workflows/form/sourceText';

import { numbersSupported } from '@/lib/utils/shared/drafter/core/grounding';
import { sourceLinkFor } from '@/lib/utils/shared/drafter/core/textFragment';
import { locateExcerpt } from '@/lib/utils/shared/drafter/core/verify';

import { BriefItem, BriefItemKind, DraftSource } from '@/types/drafter';

export interface SourceViewerProps {
  sources: DraftSource[];
  sourceId: string;
  /** Set when the viewer was opened to find the passage for this item. */
  resolving?: BriefItem;
  onSourceChange: (sourceId: string) => void;
  onAdd: (sourceId: string, selection: string, kind: BriefItemKind) => void;
  onResolve: (
    itemId: string,
    sourceId: string,
    selection: string,
    supported: boolean,
  ) => void;
  onClose: () => void;
}

const ghostButton =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-30 dark:text-gray-300 dark:hover:bg-surface-dark-elevated';
const primaryButton =
  'inline-flex min-h-[32px] items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-30';

/** The longest run of the item's words that the source actually contains. */
function bestStartingPoint(text: string, item: BriefItem): number {
  const words = item.text.split(/\s+/u).filter(Boolean);
  for (let size = Math.min(words.length, 8); size >= 3; size -= 1) {
    for (let from = 0; from + size <= words.length; from += 1) {
      const range = locateExcerpt(
        text,
        words.slice(from, from + size).join(' '),
      );
      if (range) return range.start;
    }
  }
  return -1;
}

/**
 * A source's text, for the two trusted paths into the brief: select words
 * and add them (verbatim by construction), or, for an item marked "Not found
 * in source", select the passage that proves it. Lives inside the brief
 * pane, so it is neither a modal nor a third pane.
 */
export function SourceViewer(props: SourceViewerProps) {
  const { sources, sourceId, resolving } = props;
  const t = useTranslations('workflows.drafter');
  const source = sources.find((entry) => entry.id === sourceId);
  const [loaded, setLoaded] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [selection, setSelection] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    if (!source) return;
    void getSourceText(source, []).then((text) => {
      if (!cancelled) setLoaded({ id: source.id, text });
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const text = loaded?.id === sourceId ? loaded.text : null;
  const anchorAt = useMemo(
    () => (text && resolving ? bestStartingPoint(text, resolving) : -1),
    [text, resolving],
  );

  useEffect(() => {
    anchorRef.current?.scrollIntoView({ block: 'center' });
  }, [anchorAt, text]);

  const readSelection = () => {
    const picked = window.getSelection();
    const inside =
      picked &&
      picked.rangeCount > 0 &&
      bodyRef.current?.contains(picked.getRangeAt(0).commonAncestorContainer);
    setSelection(inside ? picked.toString().trim() : '');
  };

  const spoken = resolving?.kind === 'quote' || resolving?.kind === 'testimony';
  const supported =
    !!resolving && (spoken || numbersSupported(resolving.text, selection));
  const link = source ? sourceLinkFor(source, selection) : null;

  return (
    <section
      aria-label={t('sourceViewer')}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex items-center gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <button type="button" className={ghostButton} onClick={props.onClose}>
          <IconArrowLeft size={14} aria-hidden className="rtl:-scale-x-100" />
          {t('backToBrief')}
        </button>
        <select
          className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-900 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100"
          aria-label={t('chooseSource')}
          value={sourceId}
          onChange={(event) => props.onSourceChange(event.target.value)}
        >
          {sources
            .filter((entry) => !entry.error)
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
        </select>
      </div>

      {resolving && (
        <div className="space-y-1 border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs dark:border-gray-700 dark:bg-surface-dark-elevated">
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {spoken ? t('resolveQuoteHint') : t('resolveStatementHint')}
          </p>
          <p className="text-gray-700 dark:text-gray-300" dir="auto">
            {resolving.text}
          </p>
        </div>
      )}

      <div
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 text-sm leading-relaxed text-gray-900 dark:text-gray-100"
        dir="auto"
        onMouseUp={readSelection}
        onKeyUp={readSelection}
        // Focusable so text can be selected with the keyboard (Shift+arrows
        // after placing the caret is browser-dependent; selection by pointer
        // and "select all" both report through the same handler).
        tabIndex={0}
      >
        {text === null ? (
          <span className="text-gray-600 dark:text-gray-400">
            {t('loadingSource')}
          </span>
        ) : text === '' ? (
          <span className="text-amber-900 dark:text-amber-300">
            {t('sourceUnavailable')}
          </span>
        ) : anchorAt >= 0 ? (
          <>
            {text.slice(0, anchorAt)}
            <span ref={anchorRef} />
            {text.slice(anchorAt)}
          </>
        ) : (
          text
        )}
      </div>

      <div className="space-y-2 border-t border-gray-200 p-3 dark:border-gray-700">
        <p
          className="text-xs text-gray-700 dark:text-gray-300"
          aria-live="polite"
        >
          {selection
            ? t('selectionChars', { count: selection.length })
            : t('selectToAdd')}
        </p>
        {resolving ? (
          <>
            <button
              type="button"
              className={primaryButton}
              disabled={!selection || !supported}
              onClick={() =>
                props.onResolve(resolving.id, sourceId, selection, supported)
              }
            >
              {t('useAsPassage')}
            </button>
            {selection && !supported && (
              <p className="text-xs text-amber-900 dark:text-amber-300">
                {t('passageMissingNumbers')}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              className={primaryButton}
              disabled={!selection}
              onClick={() => props.onAdd(sourceId, selection, 'quote')}
            >
              {t('addAsQuote')}
            </button>
            <button
              type="button"
              className={ghostButton}
              disabled={!selection}
              onClick={() => props.onAdd(sourceId, selection, 'fact')}
            >
              {t('addAsFact')}
            </button>
          </div>
        )}
        {link && (
          <a
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[32px] items-center gap-1 rounded text-xs text-blue-700 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-blue-300"
          >
            <IconExternalLink size={14} aria-hidden />
            {t('openSource')}
          </a>
        )}
      </div>
    </section>
  );
}
