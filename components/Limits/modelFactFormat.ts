'use client';

import { useMemo } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { formatUsdParts } from '@/lib/utils/shared/costEstimator';

/** Days up to which a wait is said in days; beyond it, in months. */
const DAYS_AS_DAYS = 60;
/** Mean days in a month, for "in 4 months". */
const DAYS_PER_MONTH = 30.4375;
const GRAMS_PER_KILOGRAM = 1000;

export interface ModelFactFormat {
  /** A whole number of people or requests. */
  count(value: number): string;
  /** A statistic that may not be whole (an average). */
  decimal(value: number): string;
  /** A share (0..1) as a percentage. */
  percent(share: number): string;
  /** Money a person reads as a total: "$30.44", "< $0.01", "$0.00". */
  usd(value: number): string;
  /** A list price per 1M tokens: "$2.50", "$15". */
  price(value: number): string;
  /** The cost of ONE request, which is far below a cent: "$0.010". */
  perRequest(value: number): string;
  /** A CO2e mass in grams or kilograms. */
  co2(grams: number): string;
  /** A calendar day: "12 Dec 2026". */
  date(isoDay: string): string;
  /** A distance in time from now: "in 21 days", "in 4 months", "3 days ago". */
  fromNow(days: number): string;
}

/**
 * How the Models page writes its numbers, in the reader's locale. One place,
 * so the grid, the open row, the runway and the map never disagree about how
 * a price or a date looks.
 */
export function useModelFactFormat(): ModelFactFormat {
  const locale = useLocale();
  const t = useTranslations('limits');
  return useMemo(() => {
    const whole = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    const oneDecimal = new Intl.NumberFormat(locale, {
      maximumFractionDigits: 1,
    });
    const percent = new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: 1,
    });
    const twoSignificant = new Intl.NumberFormat(locale, {
      maximumSignificantDigits: 2,
    });
    const currency = (options: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        ...options,
      });
    const wholeDollars = currency({ maximumFractionDigits: 0 });
    const cents = currency({
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const tiny = currency({ maximumSignificantDigits: 2 });
    const day = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    return {
      count: (value) => whole.format(value),
      decimal: (value) => oneDecimal.format(value),
      percent: (share) => percent.format(share),
      usd: (value) => {
        const parts = formatUsdParts(value, locale);
        if (parts.kind === 'zero') return t('cost.zeroAmount');
        if (parts.kind === 'lessThan') {
          return t('cost.lessThan', { amount: parts.text });
        }
        return parts.text;
      },
      price: (value) =>
        Number.isInteger(value)
          ? wholeDollars.format(value)
          : cents.format(value),
      perRequest: (value) => tiny.format(value),
      co2: (grams) =>
        grams >= GRAMS_PER_KILOGRAM
          ? t('modelAccess.facts.co2Kilograms', {
              value: oneDecimal.format(grams / GRAMS_PER_KILOGRAM),
            })
          : t('modelAccess.facts.co2Grams', {
              value: twoSignificant.format(grams),
            }),
      date: (isoDay) => day.format(new Date(`${isoDay}T00:00:00Z`)),
      fromNow: (days) =>
        Math.abs(days) <= DAYS_AS_DAYS
          ? relative.format(days, 'day')
          : relative.format(Math.round(days / DAYS_PER_MONTH), 'month'),
    };
  }, [locale, t]);
}
