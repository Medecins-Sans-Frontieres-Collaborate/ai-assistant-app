'use client';

import {
  IconChevronDown,
  IconClearAll,
  IconMenu2,
  IconTool,
} from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { useClearConversation } from '@/client/hooks/conversation/useClearConversation';
import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useUI } from '@/client/hooks/ui/useUI';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import {
  ClaudeAIIconBrand,
  DeepSeekIcon,
  MetaIcon,
  OpenAIIcon,
  XAIIcon,
} from '@/components/Icons/providers';

interface MobileHeaderProps {
  onModelSelectChange: (open: boolean) => void;
  bannerVisible?: boolean;
}

/**
 * Mobile chat header with menu button, model selector, and clear button
 * Client component - uses hooks for interactivity
 */
export function MobileChatHeader({
  onModelSelectChange,
  bannerVisible = false,
}: MobileHeaderProps) {
  const t = useTranslations();
  const { toggleChatbar } = useUI();
  const { selectedConversation, isLoaded } = useConversations();
  const { clearConversation } = useClearConversation();

  const displayModelName = selectedConversation?.model?.name || '';
  const hasMessages = (selectedConversation?.messages?.length || 0) > 0;
  // Only show agent indicator for custom/organization agents, not base models with agent capabilities
  const isAgent =
    selectedConversation?.model?.isCustomAgent === true ||
    selectedConversation?.model?.isOrganizationAgent === true;
  const modelProvider =
    OpenAIModels[selectedConversation?.model?.id as OpenAIModelID]?.provider ||
    selectedConversation?.model?.provider;

  // Helper function to get provider icon
  const getProviderIcon = (provider?: string) => {
    const iconProps = { className: 'w-4 h-4 flex-shrink-0' };
    switch (provider) {
      case 'openai':
        return <OpenAIIcon {...iconProps} />;
      case 'deepseek':
        return <DeepSeekIcon {...iconProps} />;
      case 'xai':
        return <XAIIcon {...iconProps} />;
      case 'meta':
        return <MetaIcon {...iconProps} />;
      case 'anthropic':
        return <ClaudeAIIconBrand {...iconProps} />;
      default:
        return null;
    }
  };

  return (
    <div
      className={`md:hidden fixed ${bannerVisible ? 'top-8' : 'top-0'} left-0 right-0 z-40 h-14 bg-white dark:bg-[#212121] border-b border-neutral-300 dark:border-neutral-700 flex items-center justify-between px-4 transition-all duration-300`}
    >
      <div className="flex items-center flex-1 min-w-0">
        <button
          onClick={toggleChatbar}
          className="p-2 rounded-lg text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800 transition-colors shrink-0"
          aria-label="Toggle menu"
        >
          <IconMenu2 size={24} />
        </button>

        {/* Model selection button - only show when data is loaded */}
        {isLoaded && (
          <button
            onClick={() => onModelSelectChange(true)}
            className="ml-2 flex items-center px-2 py-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors min-w-0"
            aria-label={t('chat.selectModel')}
          >
            {getProviderIcon(modelProvider)}
            <span className="font-semibold text-neutral-900 dark:text-white truncate text-base ml-1.5">
              {displayModelName || t('chat.selectModel')}
            </span>
            {isAgent && (
              <IconTool
                size={12}
                className="ml-1 text-blue-600 dark:text-blue-400 shrink-0"
                title={t('chat.azureAIAgent')}
              />
            )}
            <IconChevronDown
              size={14}
              className="ml-1 opacity-60 text-black dark:text-white shrink-0"
            />
          </button>
        )}
      </div>

      {/* Clear button */}
      {hasMessages && (
        <button
          onClick={clearConversation}
          className="p-2 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors shrink-0"
          aria-label={t('chat.clearConversation')}
          title={t('chat.clearConversation')}
        >
          <IconClearAll size={20} className="text-black dark:text-white" />
        </button>
      )}
    </div>
  );
}
