import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconInfoCircle,
  IconShieldCheck,
  IconWorld,
} from '@tabler/icons-react';
import React, { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import {
  MAX_SEARCH_RESULT_COUNT,
  MIN_SEARCH_RESULT_COUNT,
  WebSearchOptions,
} from '@/types/webSearch';

import { AzureAIIcon } from '@/components/Icons/providers';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface SearchModeSectionProps {
  searchModeEnabled: boolean;
  displaySearchMode: SearchMode;
  agentAvailable: boolean;
  modelConfig?: OpenAIModel | null;
  handleToggleSearchMode: () => void;
  handleSetSearchMode: (mode: SearchMode) => void;
}

export const SearchModeSection: FC<SearchModeSectionProps> = ({
  searchModeEnabled,
  displaySearchMode,
  agentAvailable,
  modelConfig,
  handleToggleSearchMode,
  handleSetSearchMode,
}) => {
  const t = useTranslations();

  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <IconWorld size={20} className="text-gray-600 dark:text-gray-400" />
          <div>
            <div className="font-medium text-gray-900 dark:text-white">
              {t('modelSelect.searchMode.title')}
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {t('modelSelect.searchMode.subtitle')}
            </div>
          </div>
        </div>
        <button onClick={handleToggleSearchMode} className="flex items-center">
          <div
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              searchModeEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                searchModeEnabled
                  ? 'translate-x-6 rtl:-translate-x-6'
                  : 'translate-x-1 rtl:-translate-x-1'
              }`}
            />
          </div>
        </button>
      </div>

      {searchModeEnabled && (
        <div className="space-y-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          {agentAvailable && modelConfig?.agentId ? (
            <>
              {/* Multi-option UI: routing label and radio buttons */}
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t('modelSelect.searchMode.routingLabel')}
                </div>
                <a
                  href="/info/search-mode"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                >
                  {t('modelSelect.searchMode.whatsDifference')}
                  <IconInfoCircle size={12} />
                </a>
              </div>

              <label
                className={`flex items-start gap-3 p-3 rounded-lg border-2 ${displaySearchMode === SearchMode.INTELLIGENT ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/50'} hover:border-blue-300 dark:hover:border-blue-600 cursor-pointer transition-colors`}
              >
                <input
                  type="radio"
                  name="searchRouting"
                  checked={displaySearchMode === SearchMode.INTELLIGENT}
                  onChange={() => handleSetSearchMode(SearchMode.INTELLIGENT)}
                  className="mt-0.5 w-4 h-4 text-blue-600 focus:ring-blue-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <IconWorld
                      size={16}
                      className="text-gray-600 dark:text-gray-400"
                    />
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {t('modelSelect.searchMode.privacyFocused')}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    {t('modelSelect.searchMode.privacyFocusedDescription')}
                  </div>
                </div>
              </label>

              <label
                className={`flex items-start gap-3 p-3 rounded-lg border-2 ${displaySearchMode === SearchMode.AGENT ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/50'} hover:border-blue-300 dark:hover:border-blue-600 cursor-pointer transition-colors`}
              >
                <input
                  type="radio"
                  name="searchRouting"
                  checked={displaySearchMode === SearchMode.AGENT}
                  onChange={() => handleSetSearchMode(SearchMode.AGENT)}
                  className="mt-0.5 w-4 h-4 text-blue-600 focus:ring-blue-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <AzureAIIcon className="w-4 h-4 flex-shrink-0" />
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {t('modelSelect.searchMode.azureAgentMode')}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                    {t('modelSelect.searchMode.azureAgentModeDescription')}
                  </div>
                </div>
              </label>

              {displaySearchMode === SearchMode.AGENT && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
                  <div className="flex items-start gap-2">
                    <IconAlertTriangle
                      size={16}
                      className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="text-xs font-medium text-amber-800 dark:text-amber-200 mb-1">
                        {t('modelSelect.searchMode.privacyInfoTitle')}
                      </div>
                      <div className="text-xs text-amber-700 dark:text-amber-300 mb-2">
                        {t('modelSelect.searchMode.privacyInfoDescription')}
                      </div>
                      <a
                        href="/info/search-mode"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-amber-800 dark:text-amber-200 hover:underline font-medium flex items-center gap-1"
                      >
                        {t('modelSelect.searchMode.learnMoreDataStorage')}
                        <IconInfoCircle size={12} />
                      </a>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Single-option UI: simple privacy info */
            <div className="flex items-start gap-3 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
              <IconShieldCheck
                size={20}
                className="text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-green-800 dark:text-green-200 mb-1">
                  {t('modelSelect.searchMode.privacyEnabled')}
                </div>
                <a
                  href="/info/search-mode"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-green-700 dark:text-green-300 hover:underline flex items-center gap-1"
                >
                  {t('modelSelect.searchMode.learnPrivacy')}
                  <IconInfoCircle size={12} />
                </a>
              </div>
            </div>
          )}

          <AdvancedSearchOptions />
        </div>
      )}
    </div>
  );
};

/**
 * Advanced tuning for the app-controlled layer of the search round-trip:
 * how many sources are kept and what recency the search agent prefers.
 * 'auto' freshness lets the per-message router decide (e.g. "latest news"
 * → past day); research-style questions may exceed the source count on
 * their own. Persisted globally (settingsStore), not per conversation.
 *
 * Collapsed by default — most users never touch these, and the controls
 * made the section visually busy. The disclosure row is the only thing
 * that renders until asked for.
 */
const AdvancedSearchOptions: FC = () => {
  const t = useTranslations();
  const [isOpen, setIsOpen] = useState(false);
  const webSearchOptions = useSettingsStore((s) => s.webSearchOptions);
  const setWebSearchOptions = useSettingsStore((s) => s.setWebSearchOptions);

  const freshnessValues: WebSearchOptions['freshness'][] = [
    'auto',
    'day',
    'week',
    'month',
    'any',
  ];

  return (
    <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-2 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
      >
        {isOpen ? (
          <IconChevronDown size={14} aria-hidden="true" />
        ) : (
          <IconChevronRight size={14} aria-hidden="true" />
        )}
        <IconAdjustmentsHorizontal size={14} aria-hidden="true" />
        {t('modelSelect.searchOptions.title')}
      </button>

      {!isOpen ? null : (
        <div className="mt-3 space-y-3">
          <label className="flex items-center justify-between gap-3 text-xs text-gray-600 dark:text-gray-400">
            <span className="flex-1">
              {t('modelSelect.searchOptions.resultCount')}
              <span className="ml-1 font-medium text-gray-900 dark:text-gray-100">
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
              className="w-32 accent-blue-600"
              aria-label={t('modelSelect.searchOptions.resultCount')}
            />
          </label>

          <label className="flex items-center justify-between gap-3 text-xs text-gray-600 dark:text-gray-400">
            <span className="flex-1">
              {t('modelSelect.searchOptions.freshness')}
            </span>
            <select
              value={webSearchOptions.freshness}
              onChange={(e) =>
                setWebSearchOptions({
                  freshness: e.target.value as WebSearchOptions['freshness'],
                })
              }
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              aria-label={t('modelSelect.searchOptions.freshness')}
            >
              {freshnessValues.map((value) => (
                <option key={value} value={value}>
                  {t(`modelSelect.searchOptions.freshness_${value}`)}
                </option>
              ))}
            </select>
          </label>

          <p className="text-[0.7rem] leading-snug text-gray-500 dark:text-gray-400">
            {t('modelSelect.searchOptions.hint')}
          </p>
        </div>
      )}
    </div>
  );
};
