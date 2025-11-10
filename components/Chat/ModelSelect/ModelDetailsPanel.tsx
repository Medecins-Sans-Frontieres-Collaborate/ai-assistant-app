import React, { FC } from 'react';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { AdvancedOptionsSection } from './AdvancedOptionsSection';
import { CustomAgentInfo } from './CustomAgentInfo';
import { ModelHeader } from './ModelHeader';
import { SearchModeSection } from './SearchModeSection';

interface ModelDetailsPanelProps {
  selectedModel: OpenAIModel;
  modelConfig?: OpenAIModel | null;
  isCustomAgent: boolean;
  searchModeEnabled: boolean;
  displaySearchMode: SearchMode;
  agentAvailable: boolean;
  showModelAdvanced: boolean;
  selectedConversation: Conversation | null;
  setMobileView: (view: 'list' | 'details') => void;
  handleToggleSearchMode: () => void;
  handleSetSearchMode: (mode: SearchMode) => void;
  setShowModelAdvanced: (show: boolean) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
}

export const ModelDetailsPanel: FC<ModelDetailsPanelProps> = ({
  selectedModel,
  modelConfig,
  isCustomAgent,
  searchModeEnabled,
  displaySearchMode,
  agentAvailable,
  showModelAdvanced,
  selectedConversation,
  setMobileView,
  handleToggleSearchMode,
  handleSetSearchMode,
  setShowModelAdvanced,
  updateConversation,
}) => {
  return (
    <div className="space-y-4 md:space-y-6">
      <ModelHeader
        selectedModel={selectedModel}
        modelConfig={modelConfig}
        setMobileView={setMobileView}
      />

      {isCustomAgent && <CustomAgentInfo />}

      {!isCustomAgent && (
        <SearchModeSection
          searchModeEnabled={searchModeEnabled}
          displaySearchMode={displaySearchMode}
          agentAvailable={agentAvailable}
          modelConfig={modelConfig}
          handleToggleSearchMode={handleToggleSearchMode}
          handleSetSearchMode={handleSetSearchMode}
        />
      )}

      {displaySearchMode !== SearchMode.AGENT &&
        selectedConversation &&
        (modelConfig?.supportsTemperature !== false ||
          modelConfig?.supportsReasoningEffort ||
          modelConfig?.supportsVerbosity) && (
          <AdvancedOptionsSection
            selectedConversation={selectedConversation}
            modelConfig={modelConfig}
            showModelAdvanced={showModelAdvanced}
            setShowModelAdvanced={setShowModelAdvanced}
            updateConversation={updateConversation}
          />
        )}
    </div>
  );
};
