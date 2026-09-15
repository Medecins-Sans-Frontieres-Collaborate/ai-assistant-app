import { useTranslations } from 'next-intl';

import { splitTimeoutDuration } from '@/lib/utils/shared/chat/modelTimeout';

/**
 * Localized "90 seconds" / "3 minutes" for a model timeout value (issue
 * #130). Shared by the settings control and the chat error card so the two
 * always name the same duration the same way.
 */
export function useTimeoutDurationLabel(): (seconds: number) => string {
  const t = useTranslations('common');
  return (seconds: number) => {
    const { unit, count } = splitTimeoutDuration(seconds);
    return unit === 'minutes'
      ? t('durationMinutes', { count })
      : t('durationSeconds', { count });
  };
}
