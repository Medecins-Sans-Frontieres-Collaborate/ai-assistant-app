import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Store-driven toggle for automatic link fetching. Deliberately
 * self-contained (reads settingsStore directly) — the legacy ChatSettings
 * reducer/save plumbing is not extended for new settings.
 */
export const AutoFetchLinksToggle: FC = () => {
  const t = useTranslations('urlFetch');
  const autoFetchPastedLinks = useSettingsStore((s) => s.autoFetchPastedLinks);
  const setAutoFetchPastedLinks = useSettingsStore(
    (s) => s.setAutoFetchPastedLinks,
  );

  return (
    <div>
      <h4 className="mb-2 text-sm font-medium text-black dark:text-white">
        {t('settingsTitle')}
      </h4>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={autoFetchPastedLinks}
          onChange={(e) => setAutoFetchPastedLinks(e.target.checked)}
        />
        <span>
          <span className="block text-sm text-black dark:text-gray-200">
            {t('settingsToggle')}
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {t('settingsDescription')}
          </span>
        </span>
      </label>
    </div>
  );
};
