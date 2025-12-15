import {
  IconAlertTriangle,
  IconInfoCircle,
  IconWorld,
} from '@tabler/icons-react';
import React, { FC } from 'react';

import { useTranslations } from 'next-intl';

import { getSearchModeLabels } from '@/lib/utils/app/modelTranslations';

import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AzureAIIcon } from '@/components/Icons/providers';

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
  const labels = getSearchModeLabels(t);

  return (
    <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <IconWorld size={20} className="text-gray-600 dark:text-gray-400" />
          <div>
            <div className="font-medium text-gray-900 dark:text-white">
              {labels.searchMode}
            </div>
            <div className="text-xs text-gray-600 dark:text-gray-400">
              {labels.searchModeDescription}
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
                searchModeEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </div>
        </button>
      </div>

      {searchModeEnabled && (
        <div className="space-y-3 pt-3 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
              {labels.searchRouting}:
            </div>
            <a
              href="/info/search-mode"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
            >
              {labels.whatIsTheDifference}
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
                  {labels.privacyFocusedDefault}
                </span>
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-400">
                {labels.privacyFocusedDescription}
              </div>
            </div>
          </label>

          {agentAvailable && modelConfig?.agentId && (
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
                    {labels.azureAIAgentMode}
                  </span>
                </div>
                <div className="text-xs text-gray-600 dark:text-gray-400">
                  {labels.azureAIAgentModeDescription}
                </div>
              </div>
            </label>
          )}

          {displaySearchMode === SearchMode.AGENT && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-start gap-2">
                <IconAlertTriangle
                  size={16}
                  className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5"
                />
                <div className="flex-1">
                  <div className="text-xs font-medium text-amber-800 dark:text-amber-200 mb-1">
                    {labels.importantPrivacyInformation}
                  </div>
                  <div className="text-xs text-amber-700 dark:text-amber-300 mb-2">
                    {labels.fullConversationSentWarning}
                  </div>
                  <a
                    href="/info/search-mode"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-amber-800 dark:text-amber-200 hover:underline font-medium flex items-center gap-1"
                  >
                    {labels.learnMoreDataStorage}
                    <IconInfoCircle size={12} />
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
