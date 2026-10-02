import { useCallback } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { ModelRetirement } from '@/lib/utils/shared/modelRetirement';

/**
 * One sentence saying what is happening to a retiring model, for the
 * picker's badges, chips and header. Three shapes: a dated retirement whose
 * automatic move is still ahead, a dated one past its move date, and a
 * replacement with no date (a forced move, or a deployment that already
 * runs its successor).
 */
export function useRetirementCopy(): (retirement: ModelRetirement) => string {
  const t = useTranslations('modelSelect.retiring');
  const locale = useLocale();

  return useCallback(
    ({ signal, successor }: ModelRetirement) => {
      // Azure's dates are UTC midnights; rendering them in UTC keeps the
      // day the same for every viewer (as in ModelRetirementNotice).
      const formatDate = (iso: string) =>
        new Date(iso).toLocaleDateString(locale, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        });
      if (!signal.retiresAt || !signal.movesAt) {
        return t('replaced', { successor: successor.name });
      }
      return signal.phase === 'notice'
        ? t('datedMoving', {
            date: formatDate(signal.retiresAt),
            successor: successor.name,
            movesOn: formatDate(signal.movesAt),
          })
        : t('dated', {
            date: formatDate(signal.retiresAt),
            successor: successor.name,
          });
    },
    [t, locale],
  );
}
