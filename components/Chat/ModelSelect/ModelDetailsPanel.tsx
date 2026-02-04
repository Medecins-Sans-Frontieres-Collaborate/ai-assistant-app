import React, { FC } from 'react';

import Image from 'next/image';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { OrganizationAgent } from '@/types/organizationAgent';
import { SearchMode } from '@/types/searchMode';

import { AdvancedOptionsSection } from './AdvancedOptionsSection';
import { CustomAgentInfo } from './CustomAgentInfo';
import { ModelHeader } from './ModelHeader';
import { SearchModeSection } from './SearchModeSection';

import { CustomAgent } from '@/client/stores/settingsStore';

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
  // Custom agent props for action buttons
  customAgent?: CustomAgent;
  onEditAgent?: (agent: CustomAgent) => void;
  onDeleteAgent?: (agentId: string) => void;
  // Organization agent props
  organizationAgent?: OrganizationAgent;
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
  customAgent,
  onEditAgent,
  onDeleteAgent,
  organizationAgent,
}) => {
  const hasAgentImage = organizationAgent?.image;

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header with optional background image for org agents (desktop only) */}
      {hasAgentImage ? (
        <>
          {/* Mobile: Simple header without background image */}
          <div className="md:hidden">
            <ModelHeader
              selectedModel={selectedModel}
              modelConfig={modelConfig}
              setMobileView={setMobileView}
              organizationAgent={organizationAgent}
            />
          </div>
          {/* Desktop: Header with background image */}
          <div
            className="hidden md:block relative rounded-lg overflow-hidden min-h-[300px] border"
            style={{
              borderColor: organizationAgent.color + '60',
              boxShadow: `0 0 24px ${organizationAgent.color}25`,
            }}
          >
            {/* Background image */}
            <div className="absolute inset-0">
              <Image
                src={organizationAgent.image!}
                alt=""
                fill
                className="object-cover object-right"
                priority={false}
              />
              {/* Gradient overlay for text readability */}
              <div className="absolute inset-0 bg-gradient-to-b from-black/95 via-black/75 to-black/60" />
              <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/50 to-transparent" />
            </div>
            {/* Header content */}
            <div className="relative z-10 p-8 flex flex-col justify-end h-full">
              <ModelHeader
                selectedModel={selectedModel}
                modelConfig={modelConfig}
                setMobileView={setMobileView}
                organizationAgent={organizationAgent}
                hasBackgroundImage
              />
            </div>
          </div>
        </>
      ) : (
        <ModelHeader
          selectedModel={selectedModel}
          modelConfig={modelConfig}
          setMobileView={setMobileView}
          organizationAgent={organizationAgent}
        />
      )}

      {/* Custom Agent Info with action buttons */}
      {isCustomAgent && customAgent && onEditAgent && onDeleteAgent && (
        <CustomAgentInfo
          agent={customAgent}
          onEdit={onEditAgent}
          onDelete={onDeleteAgent}
        />
      )}

      <SearchModeSection
        searchModeEnabled={searchModeEnabled}
        displaySearchMode={displaySearchMode}
        agentAvailable={agentAvailable}
        modelConfig={modelConfig}
        handleToggleSearchMode={handleToggleSearchMode}
        handleSetSearchMode={handleSetSearchMode}
      />

      {displaySearchMode !== SearchMode.AGENT &&
        selectedConversation &&
        !isCustomAgent &&
        !organizationAgent &&
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
