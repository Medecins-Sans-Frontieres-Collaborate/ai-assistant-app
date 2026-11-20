'use client';

import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  BrandFinding,
  BrandFindingSeverity,
  countBySeverity,
  sortFindings,
} from '@/lib/utils/shared/brand/brandFindings';
import {
  describeFinding,
  isColorFinding,
} from '@/lib/utils/shared/brand/brandReport';

type Filter = 'all' | BrandFindingSeverity;

const SEVERITY_DOT: Record<BrandFindingSeverity, string> = {
  error: 'bg-red-500',
  warning: 'bg-amber-400',
  info: 'bg-sky-400',
};

/** A small colour square, for a value that is a colour. */
function Swatch({ hex }: { hex: string }) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 shrink-0 rounded-sm border border-gray-300 align-[-2px] dark:border-gray-600"
      style={{ backgroundColor: hex }}
    />
  );
}

/**
 * The findings of a review beside the page: counts, a filter by severity,
 * and the list, where choosing a finding shows it on its page. The list is
 * in report order (page, rule, position).
 */
export function BrandFindingsPanel({
  findings,
  selectedId,
  onSelect,
}: {
  findings: readonly BrandFinding[];
  selectedId: string | null;
  onSelect: (finding: BrandFinding) => void;
}) {
  const t = useTranslations('workflows.brandReview');
  const [filter, setFilter] = useState<Filter>('all');
  const counts = countBySeverity(findings);
  const shown = useMemo(
    () =>
      sortFindings(findings).filter(
        (finding) => filter === 'all' || finding.severity === filter,
      ),
    [findings, filter],
  );
  const translate = (key: string, values?: Record<string, string | number>) =>
    t(key as never, values as never);

  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: t('filter.all', { count: findings.length }) },
    { id: 'error', label: t('filter.error', { count: counts.error }) },
    { id: 'warning', label: t('filter.warning', { count: counts.warning }) },
    { id: 'info', label: t('filter.info', { count: counts.info }) },
  ];

  return (
    <section
      aria-label={t('findings')}
      className="flex h-full min-h-0 flex-col"
    >
      <div
        role="radiogroup"
        aria-label={t('filter.label')}
        className="flex flex-wrap gap-1 border-b border-gray-200 p-2 dark:border-gray-800"
      >
        {filters.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={filter === option.id}
            onClick={() => setFilter(option.id)}
            className={`rounded-full px-2.5 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 ${
              filter === option.id
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
          {findings.length === 0 ? t('noFindings') : t('noneOfSeverity')}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {shown.map((finding) => {
            const selected = finding.id === selectedId;
            return (
              <li key={finding.id}>
                <button
                  type="button"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(finding)}
                  className={`flex w-full gap-2.5 border-b border-gray-100 px-3 py-2.5 text-start focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600 dark:border-gray-800/70 ${
                    selected
                      ? 'bg-blue-50 dark:bg-blue-950/40'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[finding.severity]}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                        {t(`rule.${finding.rule}`)}
                        <span className="sr-only">
                          {' '}
                          ({t(`severity.${finding.severity}`)})
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                        {finding.page === null
                          ? t('notes')
                          : t('pageShort', { page: finding.page })}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-sm text-gray-700 dark:text-gray-300">
                      {isColorFinding(finding) && (
                        <span className="me-1.5 inline-flex gap-0.5">
                          <Swatch hex={finding.found} />
                          {finding.expected[0] && (
                            <Swatch hex={finding.expected[0]} />
                          )}
                        </span>
                      )}
                      {describeFinding(finding, translate)}
                    </span>
                    {finding.source === 'model' && (
                      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                        {t('byModel')}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
