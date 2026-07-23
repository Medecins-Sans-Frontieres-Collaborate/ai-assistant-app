import { FC } from 'react';

import { useTranslations } from 'next-intl';

import {
  MAX_SEARCH_RESULT_COUNT,
  MIN_SEARCH_RESULT_COUNT,
  WebSearchOptions,
  WebSearchProviderOption,
} from '@/types/webSearch';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Store-driven web-search controls (settings panel). Deliberately
 * self-contained (reads settingsStore directly) — the legacy ChatSettings
 * reducer/save plumbing is not extended for new settings. The same
 * webSearchOptions store also backs the quick controls in the model
 * selector's Search Options, so the two stay in sync automatically.
 */
export const WebSearchSettingsPanel: FC = () => {
  const t = useTranslations('settings.webSearch');
  const webSearchOptions = useSettingsStore((s) => s.webSearchOptions);
  const setWebSearchOptions = useSettingsStore((s) => s.setWebSearchOptions);

  const providers: WebSearchProviderOption[] = [
    'auto',
    'news',
    'google-news',
    'gdelt',
    'bing-agent',
    'combined',
  ];
  const providerKey: Record<WebSearchProviderOption, string> = {
    auto: 'Auto',
    news: 'News',
    'google-news': 'GoogleNews',
    gdelt: 'Gdelt',
    'bing-agent': 'Bing',
    combined: 'Combined',
  };

  const freshnessValues: WebSearchOptions['freshness'][] = [
    'auto',
    'day',
    'week',
    'month',
    'any',
  ];

  return (
    <div className="space-y-6">
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('description')}
      </p>

      {/* Provider choice */}
      <div>
        <div className="text-sm font-bold mb-2 text-black dark:text-gray-200">
          {t('providerLabel')}
        </div>
        <div className="space-y-2">
          {providers.map((provider) => (
            <label
              key={provider}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                webSearchOptions.provider === provider
                  ? 'border-blue-400 bg-blue-50/60 dark:border-blue-500/60 dark:bg-blue-900/20'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-600'
              }`}
            >
              <input
                type="radio"
                name="webSearchProvider"
                className="mt-0.5 h-4 w-4 accent-blue-600"
                checked={webSearchOptions.provider === provider}
                onChange={() => setWebSearchOptions({ provider })}
              />
              <span>
                <span className="block text-sm font-medium text-black dark:text-gray-200">
                  {t(`provider${providerKey[provider]}`)}
                </span>
                <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  {t(`provider${providerKey[provider]}Description`)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Sources per search */}
      <div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-black dark:text-gray-200">
            {t('sourcesLabel')}
            <span className="ml-2 font-medium text-gray-600 dark:text-gray-300">
              {webSearchOptions.resultCount}
            </span>
          </span>
          <input
            type="range"
            min={MIN_SEARCH_RESULT_COUNT}
            max={MAX_SEARCH_RESULT_COUNT}
            step={1}
            value={webSearchOptions.resultCount}
            onChange={(e) =>
              setWebSearchOptions({ resultCount: Number(e.target.value) })
            }
            className="w-40 accent-blue-600"
            aria-label={t('sourcesLabel')}
          />
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('sourcesDescription')}
        </p>
      </div>

      {/* Preferred recency */}
      <div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-black dark:text-gray-200">
            {t('freshnessLabel')}
          </span>
          <select
            value={webSearchOptions.freshness}
            onChange={(e) =>
              setWebSearchOptions({
                freshness: e.target.value as WebSearchOptions['freshness'],
              })
            }
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            aria-label={t('freshnessLabel')}
          >
            {freshnessValues.map((value) => (
              <option key={value} value={value}>
                {t(`freshness_${value}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('freshnessDescription')}
        </p>
      </div>
    </div>
  );
};
