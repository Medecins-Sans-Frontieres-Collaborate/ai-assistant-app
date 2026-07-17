'use client';

import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { TranslationAnalysis, TranslationReviewRound } from '@/types/workflow';

interface AnalysisPanelProps {
  analysis?: TranslationAnalysis;
  rounds: TranslationReviewRound[];
}

/**
 * The agentic run's paper trail: pre-translation analysis findings and the
 * verdict of each review round. Collapsible section under the panes.
 */
export function AnalysisPanel({ analysis, rounds }: AnalysisPanelProps) {
  const t = useTranslations('workflows');

  if (!analysis && rounds.length === 0) return null;

  return (
    <div className="space-y-4 overflow-y-auto border-t border-gray-200 px-4 py-3 dark:border-gray-700">
      {analysis && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('translation.analysisTitle')}
          </h3>
          {analysis.register && (
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {t('translation.register')}: {analysis.register}
            </p>
          )}
          {analysis.trickyTerms.length > 0 && (
            <ul className="mt-1 space-y-1">
              {analysis.trickyTerms.map((term, i) => (
                <li
                  key={i}
                  className="text-sm text-gray-700 dark:text-gray-300"
                >
                  <span className="font-medium">{term.term}</span> —{' '}
                  {term.issue}{' '}
                  <span className="text-gray-500 dark:text-gray-400">
                    ({term.suggestion})
                  </span>
                </li>
              ))}
            </ul>
          )}
          {analysis.ambiguities.length > 0 && (
            <ul className="mt-1 space-y-1">
              {analysis.ambiguities.map((amb, i) => (
                <li
                  key={i}
                  className="text-sm text-gray-700 dark:text-gray-300"
                >
                  <span className="font-medium">“{amb.text}”</span>:{' '}
                  {amb.readings.join(' / ')}
                </li>
              ))}
            </ul>
          )}
          {analysis.notes && (
            <p className="mt-1 max-w-[75ch] text-sm text-gray-600 dark:text-gray-400">
              {analysis.notes}
            </p>
          )}
        </section>
      )}

      {rounds.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {t('translation.reviewTitle')}
          </h3>
          <ol className="mt-1 space-y-2">
            {rounds.map((round) => (
              <li key={round.round} className="text-sm">
                <span className="inline-flex items-center gap-1.5 font-medium text-gray-800 dark:text-gray-200">
                  {round.verdict === 'approve' ? (
                    <IconCheck
                      size={14}
                      aria-hidden
                      className="text-green-700 dark:text-green-400"
                    />
                  ) : (
                    <IconAlertTriangle
                      size={14}
                      aria-hidden
                      className="text-amber-600 dark:text-amber-400"
                    />
                  )}
                  {t('translation.roundLabel', { round: String(round.round) })}
                  {': '}
                  {round.verdict === 'approve'
                    ? t('translation.verdictApprove')
                    : t('translation.verdictRevise')}
                </span>
                {round.issues.length > 0 && (
                  <ul className="ms-5 mt-1 list-disc space-y-0.5 text-gray-600 dark:text-gray-400">
                    {round.issues.map((issue, i) => (
                      <li key={i}>
                        “{issue.excerpt}” — {issue.problem}{' '}
                        <span className="text-gray-500">
                          ({issue.suggestion})
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {round.changes && round.changes.length > 0 && (
                  <div className="ms-5 mt-1.5 space-y-1">
                    <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
                      {t('translation.roundChanges', {
                        round: String(round.round),
                      })}
                    </span>
                    {round.changes.map((change, i) => (
                      <p
                        key={i}
                        className="rounded-md bg-gray-50 px-2 py-1 text-xs dark:bg-surface-dark-recessed"
                      >
                        {change.before && (
                          <span className="text-red-700 line-through decoration-red-400 dark:text-red-400">
                            {change.before}
                          </span>
                        )}
                        {change.before && change.after && ' '}
                        {change.after && (
                          <span className="text-green-700 dark:text-green-400">
                            {change.after}
                          </span>
                        )}
                      </p>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
