'use client';

import { useCallback } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { formatUsdLabel } from '@/lib/utils/shared/chat/requestCost';
import {
  activityDurationParts,
  formatGrams,
} from '@/lib/utils/shared/emissions';
import {
  BudgetUnit,
  fromBaseUnits,
  isActivityUnit,
} from '@/lib/utils/shared/usageBudgets';

const SECONDS_PER_HOUR = 3600;

/** Formats a base-unit quantity (grams or dollars) in a budget's own unit. */
export type BudgetQuantityFormatter = (
  base: number,
  unit: BudgetUnit,
) => string;

/**
 * Localized display of a budget quantity in the unit the user chose:
 * "4.1 h" for an activity, "184 g CO₂e", "13.6 phone charges", "$13.10".
 *
 * Reuses the chip's formatters (grams, durations, dollars) so a figure reads
 * the same in the budget meter as it does everywhere else.
 */
export function useBudgetFormat(): BudgetQuantityFormatter {
  const t = useTranslations();
  const locale = useLocale();

  return useCallback(
    (base, unit) => {
      if (unit === 'usd') {
        return formatUsdLabel(Math.max(0, base), locale, (amount) =>
          t('emissions.chip.cost.lessThan', { amount }),
        );
      }
      if (unit === 'grams') {
        return t('emissions.chip.label', { grams: formatGrams(base) });
      }
      const value = fromBaseUnits(base, unit);
      if (isActivityUnit(unit)) {
        const parts = activityDurationParts(value * SECONDS_PER_HOUR);
        return t(`emissions.duration.${parts.unit}`, { value: parts.value });
      }
      return t('usageBudgets.chargesValue', {
        count: value < 10 ? value.toFixed(1) : `${Math.round(value)}`,
      });
    },
    [t, locale],
  );
}
