'use client';

import {
  IconAlertTriangle,
  IconCircleCheck,
  IconExternalLink,
  IconUserCheck,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { getSourceText } from '@/client/services/workflows/form/sourceText';

import { sourceLinkFor } from '@/lib/utils/shared/drafter/core/textFragment';
import {
  Passage,
  locateExcerpt,
  passageAround,
} from '@/lib/utils/shared/drafter/core/verify';

import { BriefItem, DraftSource } from '@/types/drafter';

interface ProofCardProps {
  item: BriefItem;
  sources: DraftSource[];
}

/** Icon plus words for how an item was verified; never colour alone. */
export function VerificationMark({
  verified,
}: {
  verified: BriefItem['verified'];
}) {
  const t = useTranslations('workflows.drafter');
  if (verified === 'verbatim') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-800 dark:text-green-300">
        <IconCircleCheck size={14} aria-hidden />
        {t('foundInSource')}
      </span>
    );
  }
  if (verified === 'user-asserted') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-700 dark:text-gray-300">
        <IconUserCheck size={14} aria-hidden />
        {t('youVouched')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-900 dark:text-amber-300">
      <IconAlertTriangle size={14} aria-hidden />
      {t('notFoundInSource')}
    </span>
  );
}

/**
 * The evidence for one brief item: the excerpt inside its surrounding
 * passage with the match marked, the source's name, and "Open source". The
 * same card serves a brief row and a quote or number inside a version, so
 * proof looks identical wherever it is asked for.
 */
export function ProofCard({ item, sources }: ProofCardProps) {
  const t = useTranslations('workflows.drafter');
  const provenance = item.provenance[0];
  const source = provenance
    ? sources.find((entry) => entry.id === provenance.sourceId)
    : undefined;
  // Keyed by what was looked up, so a result for a previous item is simply
  // not this item's result; nothing has to be reset when the item changes.
  const lookupKey =
    source && provenance ? `${source.id}:${provenance.excerpt}` : '';
  const [lookup, setLookup] = useState<{
    key: string;
    passage: Passage | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!source || !provenance) return;
    void getSourceText(source, []).then((text) => {
      if (cancelled) return;
      const range = text ? locateExcerpt(text, provenance.excerpt) : null;
      setLookup({
        key: lookupKey,
        passage: text && range ? passageAround(text, range) : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [source, provenance, lookupKey]);

  const loaded = lookup?.key === lookupKey ? lookup : null;
  const passage = loaded?.passage ?? null;
  const missing = !!loaded && !loaded.passage;

  if (!provenance || !source) {
    return (
      <div className="space-y-1 text-xs text-gray-700 dark:text-gray-300">
        <VerificationMark verified={item.verified} />
        <p>
          {item.verified === 'user-asserted'
            ? t('vouchConsequence')
            : t('notFoundHelper')}
        </p>
      </div>
    );
  }

  const link = sourceLinkFor(source, provenance.excerpt);

  return (
    <div className="space-y-2 text-xs">
      {item.original && (
        // A translated item: what was verified is the ORIGINAL, so that is
        // what the proof shows first, named as such.
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {t('translatedFrom', { language: item.original.language })}
          </p>
          <p className="text-gray-700 dark:text-gray-300" dir="auto">
            {item.original.text}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <VerificationMark verified={item.verified} />
        <span className="min-w-0 truncate text-gray-700 dark:text-gray-300">
          {source.name}
        </span>
      </div>
      <blockquote
        className="max-h-40 overflow-y-auto rounded border border-gray-200 bg-white p-2 leading-relaxed text-gray-800 dark:border-gray-700 dark:bg-surface-dark dark:text-gray-200"
        dir="auto"
      >
        {passage ? (
          <>
            {passage.clippedStart && '… '}
            {passage.before}
            <mark className="rounded-sm bg-blue-100 px-0.5 text-gray-900 dark:bg-blue-900/60 dark:text-gray-50">
              {passage.match}
            </mark>
            {passage.after}
            {passage.clippedEnd && ' …'}
          </>
        ) : (
          // The stored excerpt is shown even when the source can no longer
          // be read, so proof never silently disappears.
          <mark className="rounded-sm bg-blue-100 px-0.5 text-gray-900 dark:bg-blue-900/60 dark:text-gray-50">
            {provenance.excerpt}
          </mark>
        )}
      </blockquote>
      {missing && (
        <p className="text-amber-900 dark:text-amber-300">
          {t('sourceUnavailable')}
        </p>
      )}
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[32px] items-center gap-1 rounded text-blue-700 underline underline-offset-2 hover:text-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:text-blue-300"
          title={
            link.atPassage
              ? t('opensAtPassage', { host: link.host })
              : t('opensSource', { host: link.host })
          }
        >
          <IconExternalLink size={14} aria-hidden />
          {t('openSource')}
        </a>
      )}
    </div>
  );
}
