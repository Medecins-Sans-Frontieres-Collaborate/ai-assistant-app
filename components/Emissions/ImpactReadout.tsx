'use client';

import { FC, ReactNode } from 'react';

import { useTranslations } from 'next-intl';

import {
  ASSUMPTIONS_VERSION,
  EMISSIONS_CHIP_VISIBILITY_OPTIONS,
  EmissionsChipVisibility,
  activityDurationParts,
  estimateActivityEquivalents,
} from '@/lib/utils/shared/emissions';

import { useSettingsStore } from '@/client/stores/settingsStore';

/** <1 g shows decimals ("0.42"); larger values round to whole grams. */
export const formatGrams = (grams: number): string =>
  grams < 1
    ? grams.toFixed(2)
    : grams < 10
      ? grams.toFixed(1)
      : `${Math.round(grams)}`;

export interface ImpactRow {
  label: string;
  grams: number;
  /** Secondary line under the value (e.g. "Agentic translation · 4 calls"). */
  detail?: string;
  /** Renders dimmer, for a row that splits a row above it. */
  muted?: boolean;
}

interface ImpactReadoutProps {
  title: string;
  rows: ImpactRow[];
  /** Total the "same carbon as" equivalents are computed from. */
  equivalentsFrom: number;
  /** Surface-specific sentence appended to the shared disclaimer. */
  disclaimerKey: string;
  /** Extra sections (e.g. a "By action" block) rendered above the disclaimer. */
  children?: ReactNode;
}

/**
 * The body of the emissions popover, shared VERBATIM by the chat chip and the
 * workflow impact badge (docs/WORKFLOW_EMISSIONS_DESIGN.md §5b).
 *
 * The point of the extraction is that the two surfaces can never drift on the
 * things that carry meaning — rounding, the equivalents, the assumptions
 * version in the disclaimer, and the visibility switcher that governs both.
 * Only the ROWS differ, because only the unit of attribution differs: a turn
 * in chat, a run in a workflow.
 */
export const ImpactReadout: FC<ImpactReadoutProps> = ({
  title,
  rows,
  equivalentsFrom,
  disclaimerKey,
  children,
}) => {
  const t = useTranslations();
  const visibility = useSettingsStore((s) => s.emissionsChipVisibility);
  const setVisibility = useSettingsStore((s) => s.setEmissionsChipVisibility);

  return (
    <>
      <p className="mb-2 font-semibold text-gray-900 dark:text-gray-100">
        {title}
      </p>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="flex items-center justify-between gap-3">
              <span
                className={
                  row.muted
                    ? 'text-gray-500 dark:text-gray-500'
                    : 'text-gray-600 dark:text-gray-400'
                }
              >
                {row.label}
              </span>
              <span
                className={`shrink-0 ${
                  row.muted
                    ? 'text-gray-600 dark:text-gray-400'
                    : 'text-gray-900 dark:text-gray-100'
                }`}
              >
                {t('emissions.chip.label', { grams: formatGrams(row.grams) })}
              </span>
            </div>
            {row.detail && (
              <p className="text-[10px] leading-snug text-gray-500 dark:text-gray-400">
                {row.detail}
              </p>
            )}
          </div>
        ))}
      </div>

      {children}

      <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
        <p className="mb-1 font-medium text-gray-700 dark:text-gray-300">
          {t('emissions.equivalents.title')}
        </p>
        <div className="space-y-0.5">
          {estimateActivityEquivalents(equivalentsFrom).map((equivalent) => {
            const { unit, value } = activityDurationParts(equivalent.seconds);
            return (
              <div
                key={equivalent.key}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-gray-600 dark:text-gray-400">
                  {t(`emissions.activities.${equivalent.key}`)}
                </span>
                <span className="text-gray-900 dark:text-gray-100 shrink-0">
                  {t(`emissions.duration.${unit}`, { value })}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-2 border-t border-gray-200 pt-2 text-[10px] leading-snug text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {t(disclaimerKey, { version: ASSUMPTIONS_VERSION })}
      </p>

      {/* Mode switcher — the chip's own settings are otherwise three clicks
          away, and "Hide" needs its undo stated in place. One setting governs
          both surfaces, so switching here switches everywhere. */}
      <div className="mt-2 border-t border-gray-200 pt-2 dark:border-gray-700">
        <div
          role="group"
          aria-label={t('emissions.chip.visibilityGroup')}
          className="flex items-center gap-1"
        >
          <span className="me-1 text-[10px] text-gray-500 dark:text-gray-400">
            {t('emissions.chip.visibilityLabel')}
          </span>
          {EMISSIONS_CHIP_VISIBILITY_OPTIONS.map(
            (mode: EmissionsChipVisibility) => (
              <button
                key={mode}
                type="button"
                onClick={() => setVisibility(mode)}
                aria-pressed={visibility === mode}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                  visibility === mode
                    ? 'bg-gray-200 text-gray-900 dark:bg-gray-700 dark:text-gray-100'
                    : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                }`}
              >
                {t(`emissions.chip.visibility.${mode}`)}
              </button>
            ),
          )}
        </div>
        <p className="mt-1 text-[10px] leading-snug text-gray-500 dark:text-gray-400">
          {t('emissions.chip.visibilityHint')}
        </p>
      </div>
    </>
  );
};
