'use client';

import { useCallback } from 'react';

import { useTranslations } from 'next-intl';

import { co2eMassParts } from '@/lib/utils/shared/emissions';

/** Formats a mass given in grams of CO₂e, unit included. */
export type Co2eFormatter = (grams: number) => string;

/**
 * Localized display of a CO₂e mass, scaled to the unit that reads best:
 * "0.42 g CO₂e", "184 g CO₂e", "12.5 kg CO₂e".
 *
 * The one place a standalone CO₂e figure gets its unit, so a total reads the
 * same in the chip's popover, the budget meters and the settings page.
 *
 * @returns A stable formatter taking grams and returning the labelled figure.
 */
export function useCo2eFormat(): Co2eFormatter {
  const t = useTranslations();
  return useCallback(
    (grams) => {
      const parts = co2eMassParts(grams);
      return t(`emissions.mass.${parts.unit}`, { value: parts.value });
    },
    [t],
  );
}
