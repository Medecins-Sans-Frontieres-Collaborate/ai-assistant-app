'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { MediaThumb } from './MediaThumb';
import { PreviewSegmentModel, PreviewTokenModel } from './adapterUi';

interface VersionPreviewProps {
  /** The target's name, shown as the author line. */
  name: string;
  segments: PreviewSegmentModel[];
  /** Messages namespace of the kind, for the fold label. */
  namespace: string;
  language?: string;
  /** Pressing text returns to the editor with the caret at that spot. */
  onEditAt: (segmentId: string, offset: number) => void;
}

/**
 * A version roughly as its target will show it: the fold, links as they are
 * displayed, hashtags and mentions as links, a thread as connected posts.
 *
 * Deliberately NOT a copy of any platform. It is drawn in this product's
 * own palette with a neutral avatar and the channel's name in words, and it
 * says "Approximate": platforms change how they render without notice.
 * Read-only, so it never becomes a second place to look for problems;
 * pressing the text goes back to the editor.
 */
export function VersionPreview({
  name,
  segments,
  namespace,
  language,
  onEditAt,
}: VersionPreviewProps) {
  const t = useTranslations('workflows.drafter');
  const tKind = useTranslations(namespace);
  const [expanded, setExpanded] = useState(false);

  // Every run carries its offset, which the click handler reads to put the
  // caret back at the word that was pressed.
  const renderTokens = (tokens: PreviewTokenModel[]) =>
    tokens.map((token) =>
      token.kind === 'text' ? (
        <span key={token.start} data-start={token.start}>
          {token.display}
        </span>
      ) : (
        // Styled as the platform styles it; not a real link, since the
        // point is how it reads, and a press should go to the editor.
        <span
          key={token.start}
          data-start={token.start}
          className="text-blue-700 dark:text-blue-300"
        >
          {token.display}
        </span>
      ),
    );

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {t('previewApproximate')}
      </p>
      <ol className="space-y-0">
        {segments.map((segment, index) => {
          const last = index === segments.length - 1;
          return (
            <li key={segment.id} className="flex gap-2">
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className="h-8 w-8 shrink-0 rounded-full bg-gray-200 dark:bg-gray-700"
                />
                {!last && (
                  <span
                    aria-hidden
                    className="w-px flex-1 bg-gray-300 dark:bg-gray-600"
                  />
                )}
              </div>
              <div className={`min-w-0 flex-1 ${last ? '' : 'pb-4'}`}>
                <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {name}
                </p>
                <div
                  role="button"
                  tabIndex={0}
                  lang={language || undefined}
                  dir="auto"
                  aria-label={t('previewEdit', { n: index + 1 })}
                  className="mt-0.5 cursor-text whitespace-pre-wrap break-words rounded text-sm leading-relaxed text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-100"
                  onClick={(event) => {
                    // The token under the pointer carries its offset.
                    const target = event.target as HTMLElement;
                    const offset = Number(target.dataset.start ?? 0);
                    onEditAt(segment.id, Number.isFinite(offset) ? offset : 0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onEditAt(segment.id, 0);
                    }
                  }}
                >
                  {renderTokens(segment.visible)}
                  {segment.hidden.length > 0 &&
                    (expanded ? (
                      renderTokens(segment.hidden)
                    ) : (
                      <span className="text-gray-600 dark:text-gray-400">
                        {'… '}
                      </span>
                    ))}
                  {segment.numbering && (
                    <span className="text-gray-600 dark:text-gray-400">
                      {` ${segment.numbering}`}
                    </span>
                  )}
                </div>
                {segment.hidden.length > 0 && segment.foldLabelKey && (
                  <button
                    type="button"
                    className="mt-0.5 rounded text-sm text-gray-700 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-gray-300"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((open) => !open)}
                  >
                    {expanded
                      ? t('previewShowLess')
                      : tKind(`slots.${segment.foldLabelKey}`)}
                  </button>
                )}
                {segment.media.length > 0 && (
                  <ul
                    className={`mt-2 grid gap-1 ${
                      segment.media.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
                    }`}
                  >
                    {segment.media.map((item) => (
                      <li key={item.id} className="relative">
                        <MediaThumb
                          imageRef={item.ref}
                          alt={item.alt}
                          className="aspect-video w-full"
                        />
                        <span
                          className={`absolute bottom-1 start-1 rounded px-1 text-[10px] font-semibold ${
                            item.alt.trim()
                              ? 'bg-gray-900/80 text-white'
                              : 'bg-amber-200 text-amber-950'
                          }`}
                          title={item.alt.trim() || t('altMissingShort')}
                        >
                          {item.alt.trim() ? 'ALT' : t('altMissingShort')}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {segment.linkCards.map((card) => (
                  <div
                    key={`${card.host}:${card.title}`}
                    className="mt-2 rounded-lg border border-gray-300 px-2 py-1.5 dark:border-gray-600"
                  >
                    <p className="text-xs text-gray-600 dark:text-gray-400">
                      {card.host}
                    </p>
                    <p
                      className="truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                      dir="auto"
                    >
                      {card.title}
                    </p>
                  </div>
                ))}
                {segment.over > 0 && (
                  <p className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-900 dark:text-amber-300">
                    <IconAlertTriangle size={13} aria-hidden />
                    {t('previewOver', { count: segment.over })}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
