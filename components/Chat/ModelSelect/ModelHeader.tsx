import { IconChevronLeft } from '@tabler/icons-react';
import React, { FC } from 'react';

import { OpenAIModel } from '@/types/openai';

import { ModelProviderIcon } from './ModelProviderIcon';

interface ModelHeaderProps {
  selectedModel: OpenAIModel;
  modelConfig?: OpenAIModel | null;
  setMobileView: (view: 'list' | 'details') => void;
}

export const ModelHeader: FC<ModelHeaderProps> = ({
  selectedModel,
  modelConfig,
  setMobileView,
}) => {
  return (
    <div>
      <button
        onClick={() => setMobileView('list')}
        className="md:hidden flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 mb-4"
      >
        <IconChevronLeft size={16} />
        Back to Models
      </button>

      <div className="flex items-center gap-2 md:gap-3 mb-3">
        <ModelProviderIcon
          provider={selectedModel.provider || modelConfig?.provider}
          size="lg"
        />
        <h2 className="text-xl md:text-2xl font-semibold text-gray-900 dark:text-white">
          {selectedModel.name}
        </h2>
      </div>
      <p className="text-sm md:text-base text-gray-600 dark:text-gray-400 mb-3">
        {selectedModel.description || modelConfig?.description}
      </p>

      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
            modelConfig?.modelType === 'reasoning'
              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
              : modelConfig?.modelType === 'omni'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                : modelConfig?.modelType === 'agent'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300'
          }`}
        >
          {modelConfig?.modelType || 'foundational'}
        </span>
        {modelConfig?.knowledgeCutoff && (
          <span className="text-xs text-gray-600 dark:text-gray-400">
            Knowledge cutoff: {modelConfig.knowledgeCutoff}
          </span>
        )}
      </div>
    </div>
  );
};
