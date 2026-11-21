'use client';

import { useTranslations } from 'next-intl';

import {
  DraftGrounding,
  groundingKey,
} from '@/lib/utils/shared/brand/draftGrounding';

/**
 * What the editor's sections need to say where a drafted value is stated:
 * the lookup, and the guide to open at a page (null when it cannot be
 * shown).
 */
export interface DraftGroundingView {
  lookup: DraftGrounding;
  guideUrl: string | null;
}

/**
 * One line under a drafted row: the guide page that states its value, or
 * that the guide's text does not state it, and which of the values listed
 * with it (substitutes, alternatives) are not stated either. Renders
 * nothing for a value the draft did not make (the admin's own, or one
 * edited since): nothing is claimed about those.
 */
export function DraftGroundingLine({
  view,
  list,
  value,
  others = [],
  normalize = groundingKey,
}: {
  view: DraftGroundingView | undefined;
  /** Which list of the lookup the row's values are in. */
  list: keyof DraftGrounding;
  /** The row's own value. */
  value: string;
  /** Values listed with it. */
  others?: readonly string[];
  /** How this list's values are keyed. */
  normalize?: (value: string) => string;
}) {
  const t = useTranslations('adminBrandBooks');
  if (!view) return null;
  const pages = view.lookup[list];
  const page = pages[normalize(value)];
  const missing = others.filter((other) => pages[normalize(other)] === null);
  if (page === undefined && missing.length === 0) return null;
  const warnClass = 'text-amber-800 dark:text-amber-300';
  return (
    <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
      {typeof page === 'number' &&
        (view.guideUrl ? (
          <a
            href={`${view.guideUrl}#page=${page}`}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-gray-900 dark:hover:text-gray-200"
          >
            {t('guide.stated', { page })}
          </a>
        ) : (
          t('guide.stated', { page })
        ))}
      {page === null && (
        <span className={warnClass}>{t('guide.notStated')}</span>
      )}
      {missing.length > 0 && (
        <span className={warnClass}>
          {page !== undefined && ' '}
          {t('guide.othersNotStated', { values: missing.join(', ') })}
        </span>
      )}
    </p>
  );
}
