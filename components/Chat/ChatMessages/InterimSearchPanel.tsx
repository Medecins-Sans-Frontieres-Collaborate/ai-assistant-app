'use client';

import { IconExternalLink, IconNews, IconSparkles } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useChatStore } from '@/client/stores/chatStore';
import type { SearchInterimPayload } from '@/lib/streamMarkers';

const MAX_VISIBLE_HEADLINES = 6;

/**
 * Per-item stagger for the streamed-in reveal. Headlines arrive in one
 * marker, but revealing them one-by-one keeps the long Bing wait (35-90s)
 * visually alive — a few seconds of entrance animation against a
 * half-minute wait costs nothing.
 */
const HEADLINE_STAGGER_MS = 950;

/**
 * Interim results of a combined (Bing + Google News) search, rendered on
 * the in-progress assistant message while the slow Bing leg is still
 * running (35-90s). Headlines stream in one at a time (staggered entrance;
 * static under prefers-reduced-motion) and the title shimmers like the
 * chat loader to signal the deep search is still working. Clicking the
 * action aborts the Bing wait and resends the turn with these headlines
 * echoed back (no re-search). Disappears when the full search finishes
 * and answer tokens start streaming.
 */
export const InterimSearchPanel: FC<{ interim: SearchInterimPayload }> = ({
  interim,
}) => {
  const t = useTranslations('chat.interimSearch');
  const summarizeFromHeadlines = useChatStore((s) => s.summarizeFromHeadlines);
  // One-shot: the click aborts the current stream and starts the resend;
  // disable immediately so a second click can't race the teardown.
  const [clicked, setClicked] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const entries = expanded
    ? interim.entries
    : interim.entries.slice(0, MAX_VISIBLE_HEADLINES);
  if (entries.length === 0) return null;
  const hiddenCount = interim.entries.length - MAX_VISIBLE_HEADLINES;
  // Footer (count/hint/button) slides in after the last of the INITIAL
  // headlines; expanding later must not re-delay it.
  const footerDelayMs =
    Math.min(interim.entries.length, MAX_VISIBLE_HEADLINES) *
    HEADLINE_STAGGER_MS;

  /**
   * Initial headlines keep their slow streamed-in stagger; ones revealed
   * by "Show all" mount at expand time and cascade quickly instead of
   * inheriting multi-second delays. Constant per index so re-renders never
   * restart an already-played entrance.
   */
  const entryDelayMs = (idx: number) =>
    idx < MAX_VISIBLE_HEADLINES
      ? idx * HEADLINE_STAGGER_MS
      : (idx - MAX_VISIBLE_HEADLINES) * 80;

  return (
    <div className="my-3 max-w-prose not-prose rounded-lg border border-gray-200 bg-gray-50 p-3 animate-fade-in-fast motion-reduce:animate-none dark:border-gray-700 dark:bg-gray-900/50">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <IconNews
          size={14}
          className="text-gray-600 dark:text-gray-400"
          aria-hidden="true"
        />
        {/* Same wave-shimmer treatment as the chat loader: gray gradient
            text with a traveling blue band — reads as "still working".
            Without animation (reduced motion) the static gradient keeps
            the text legible. */}
        <span
          className="bg-clip-text text-transparent animate-shimmer-wave motion-reduce:animate-none [--wave-base:#6b7280] [--wave-color:#3b82f6] dark:[--wave-base:#9ca3af] dark:[--wave-color:#60a5fa]"
          style={{
            backgroundImage:
              'linear-gradient(to right, var(--wave-base) 0%, var(--wave-base) 60%, var(--wave-color) 75%, var(--wave-base) 90%, var(--wave-base) 100%)',
            backgroundSize: '200% 100%',
          }}
        >
          {t('title')}
        </span>
        <span className="ml-auto text-gray-500 dark:text-gray-400">
          {t('sourcesCount', { count: interim.entries.length })}
        </span>
      </div>

      <ul className="mt-2 space-y-1">
        {entries.map((entry, idx) => (
          <li
            key={entry.url}
            className="truncate text-xs text-gray-600 dark:text-gray-400 animate-headline-in motion-reduce:animate-none"
            style={{ animationDelay: `${entryDelayMs(idx)}ms` }}
          >
            <a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-full items-center gap-1 hover:text-gray-900 hover:underline dark:hover:text-gray-200"
            >
              <span className="truncate">{entry.title}</span>
              {entry.sourceName && (
                <span className="shrink-0 text-gray-400 dark:text-gray-500">
                  · {entry.sourceName}
                </span>
              )}
              <IconExternalLink
                size={10}
                className="shrink-0"
                aria-hidden="true"
              />
            </a>
          </li>
        ))}
      </ul>

      <div
        className="animate-headline-in motion-reduce:animate-none"
        style={{ animationDelay: `${footerDelayMs}ms` }}
      >
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mt-1 text-xs text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
          >
            {expanded
              ? t('showFewer')
              : t('showAll', { count: interim.entries.length })}
          </button>
        )}
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('hint', { count: interim.entries.length })}
        </p>
        <button
          type="button"
          disabled={clicked}
          onClick={() => {
            setClicked(true);
            void summarizeFromHeadlines();
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-500/50 dark:bg-blue-900/20 dark:text-blue-300 dark:hover:bg-blue-900/40"
        >
          <IconSparkles size={14} aria-hidden="true" />
          {t('summarizeNow')}
        </button>
      </div>
    </div>
  );
};
