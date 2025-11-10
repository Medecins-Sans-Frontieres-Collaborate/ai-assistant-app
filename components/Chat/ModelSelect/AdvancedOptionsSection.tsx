import {
  IconChevronDown,
  IconChevronUp,
  IconInfoCircle,
  IconSettings,
} from '@tabler/icons-react';
import React, { FC } from 'react';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { TemperatureSlider } from '@/components/Settings/Temperature';

interface AdvancedOptionsSectionProps {
  selectedConversation: Conversation;
  modelConfig?: OpenAIModel | null;
  showModelAdvanced: boolean;
  setShowModelAdvanced: (show: boolean) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
}

export const AdvancedOptionsSection: FC<AdvancedOptionsSectionProps> = ({
  selectedConversation,
  modelConfig,
  showModelAdvanced,
  setShowModelAdvanced,
  updateConversation,
}) => {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg">
      <button
        onClick={() => setShowModelAdvanced(!showModelAdvanced)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-lg transition-colors"
      >
        <div className="flex items-center gap-2">
          <IconSettings
            size={18}
            className="text-gray-600 dark:text-gray-400"
          />
          <span className="text-sm font-medium text-gray-900 dark:text-white">
            Advanced Options
          </span>
        </div>
        {showModelAdvanced ? (
          <IconChevronUp
            size={18}
            className="text-gray-600 dark:text-gray-400"
          />
        ) : (
          <IconChevronDown
            size={18}
            className="text-gray-600 dark:text-gray-400"
          />
        )}
      </button>

      {showModelAdvanced && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4">
          {modelConfig?.supportsTemperature !== false && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Temperature
              </label>
              <TemperatureSlider
                temperature={selectedConversation.temperature || 0.5}
                onChangeTemperature={(temperature) =>
                  updateConversation(selectedConversation.id, {
                    temperature,
                  })
                }
              />
            </div>
          )}

          {modelConfig?.supportsTemperature === false && (
            <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 text-xs">
              <div className="flex items-start">
                <IconInfoCircle
                  size={16}
                  className="mr-2 mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400"
                />
                <div className="text-blue-700 dark:text-blue-300">
                  <strong>Note:</strong> This model uses fixed temperature
                  values for consistent performance.
                </div>
              </div>
            </div>
          )}

          {modelConfig?.supportsReasoningEffort && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Reasoning Effort
              </label>
              <div className="grid grid-cols-4 gap-2">
                {modelConfig?.supportsMinimalReasoning && (
                  <button
                    onClick={() =>
                      updateConversation(selectedConversation.id, {
                        reasoningEffort: 'minimal',
                      })
                    }
                    className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                      (selectedConversation.reasoningEffort ||
                        selectedConversation.model.reasoningEffort) ===
                      'minimal'
                        ? 'bg-blue-600 text-white shadow-md'
                        : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                  >
                    Minimal
                  </button>
                )}
                <button
                  onClick={() =>
                    updateConversation(selectedConversation.id, {
                      reasoningEffort: 'low',
                    })
                  }
                  className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                    (selectedConversation.reasoningEffort ||
                      selectedConversation.model.reasoningEffort) === 'low'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  Low
                </button>
                <button
                  onClick={() =>
                    updateConversation(selectedConversation.id, {
                      reasoningEffort: 'medium',
                    })
                  }
                  className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                    (selectedConversation.reasoningEffort ||
                      selectedConversation.model.reasoningEffort) === 'medium'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  Medium
                </button>
                <button
                  onClick={() =>
                    updateConversation(selectedConversation.id, {
                      reasoningEffort: 'high',
                    })
                  }
                  className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                    (selectedConversation.reasoningEffort ||
                      selectedConversation.model.reasoningEffort) === 'high'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  High
                </button>
              </div>
            </div>
          )}

          {modelConfig?.supportsVerbosity && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Verbosity
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() =>
                    updateConversation(selectedConversation.id, {
                      verbosity: 'low',
                    })
                  }
                  className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                    (selectedConversation.verbosity ||
                      selectedConversation.model.verbosity) === 'low'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  Low
                </button>
                <button
                  onClick={() =>
                    updateConversation(selectedConversation.id, {
                      verbosity: 'medium',
                    })
                  }
                  className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                    (selectedConversation.verbosity ||
                      selectedConversation.model.verbosity) === 'medium'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  Medium
                </button>
                <button
                  onClick={() =>
                    updateConversation(selectedConversation.id, {
                      verbosity: 'high',
                    })
                  }
                  className={`px-3 py-2 text-sm font-medium rounded-lg transition-all ${
                    (selectedConversation.verbosity ||
                      selectedConversation.model.verbosity) === 'high'
                      ? 'bg-blue-600 text-white shadow-md'
                      : 'bg-gray-100 dark:bg-gray-700/50 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  High
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
