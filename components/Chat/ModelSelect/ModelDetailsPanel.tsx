import React, { FC } from 'react';

import Image from 'next/image';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { OrganizationAgent } from '@/types/organizationAgent';
import { SearchMode } from '@/types/searchMode';

import { AdvancedOptionsSection } from './AdvancedOptionsSection';
import { CustomAgentInfo } from './CustomAgentInfo';
import { DeploymentDetailsSection } from './DeploymentDetailsSection';
import { HostedRegionSection } from './HostedRegionSection';
import { ModelHeader } from './ModelHeader';
import { RecentSourcesSection } from './RecentSourcesSection';
import { VariantSection } from './VariantSection';
import { VersionSection } from './VersionSection';

import { CustomAgent } from '@/client/stores/settingsStore';

interface ModelDetailsPanelProps {
  selectedModel: OpenAIModel;
  modelConfig?: OpenAIModel | null;
  isCustomAgent: boolean;
  /**
   * Conversation search-mode default, only consulted to hide the advanced
   * options under AGENT routing. The search/interpreter controls themselves
   * moved to the composer's capabilities tray (ToolModeControls).
   */
  displaySearchMode: SearchMode;
  showModelAdvanced: boolean;
  selectedConversation: Conversation | null;
  setMobileView: (view: 'list' | 'details') => void;
  setShowModelAdvanced: (show: boolean) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  /** Selects another version of the selected model's series (base models). */
  onSelectVersion?: (model: OpenAIModel) => void;
  /**
   * All visible custom-source (byom) models. Feeds the Variant/Version
   * switchers when the selection is a byom model, whose family lives
   * outside the catalog list.
   */
  customSourceModels?: OpenAIModel[];
  /** Display name of the byom source the selected model came from. */
  customSourceName?: string;
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
  displaySearchMode,
  showModelAdvanced,
  selectedConversation,
  setMobileView,
  setShowModelAdvanced,
  updateConversation,
  onSelectVersion,
  customSourceModels,
  customSourceName,
  customAgent,
  onEditAgent,
  onDeleteAgent,
  organizationAgent,
}) => {
  const hasAgentImage = organizationAgent?.image;
  const isCustomSourceModel = selectedModel.isCustomSourceModel === true;

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header with optional background image for org agents (desktop only) */}
      {hasAgentImage ? (
        <>
          {/* Desktop: Header with background image - rendered first to avoid space-y margin */}
          <div
            className="hidden md:block relative rounded-lg overflow-hidden min-h-[220px] border"
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
                sizes="(min-width: 768px) 50vw, 100vw"
                className="object-cover object-right"
                priority
              />
              {/* Gradient overlay for text readability */}
              <div className="absolute inset-0 bg-gradient-to-b from-black/95 via-black/75 to-black/60" />
              <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-black/50 to-transparent" />
            </div>
            {/* Header content */}
            <div className="relative z-10 p-6 pt-5 flex flex-col justify-start h-full">
              <ModelHeader
                selectedModel={selectedModel}
                modelConfig={modelConfig}
                setMobileView={setMobileView}
                organizationAgent={organizationAgent}
                hasBackgroundImage
              />
            </div>
          </div>
          {/* Mobile: Simple header without background image */}
          <div className="md:hidden">
            <ModelHeader
              selectedModel={selectedModel}
              modelConfig={modelConfig}
              setMobileView={setMobileView}
              organizationAgent={organizationAgent}
            />
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

      {/* Variant + version switchers for family models (list shows one row
          per family; variant = size/tier axis, version chips follow the
          active variant) */}
      {!isCustomAgent && !organizationAgent && onSelectVersion && (
        <>
          <VariantSection
            selectedModel={selectedModel}
            onSelectVariant={onSelectVersion}
            familyModels={isCustomSourceModel ? customSourceModels : undefined}
          />
          <VersionSection
            selectedModel={selectedModel}
            onSelectVersion={onSelectVersion}
            familyModels={isCustomSourceModel ? customSourceModels : undefined}
          />
        </>
      )}

      {/* Provenance of custom-source (byom) models: source, account, region,
          ARM deployment. */}
      {isCustomSourceModel && (
        <DeploymentDetailsSection
          selectedModel={selectedModel}
          sourceName={customSourceName}
        />
      )}

      {/* Hosting-region choice for base models (US users, dual-hosted) */}
      {!isCustomAgent && !organizationAgent && (
        <HostedRegionSection
          selectedModel={selectedModel}
          selectedConversation={selectedConversation}
          updateConversation={updateConversation}
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

      {/* Recent Sources for RAG organization agents */}
      {organizationAgent?.type === 'rag' && (
        <RecentSourcesSection agentId={organizationAgent.id} />
      )}

      {/* Search-mode and code-interpreter defaults moved to the composer's
          capabilities tray (ToolModeControls) — the picker picks models. */}

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
