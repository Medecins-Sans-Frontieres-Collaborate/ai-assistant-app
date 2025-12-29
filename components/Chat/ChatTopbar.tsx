import {
  IconChevronDown,
  IconClearAll,
  IconDots,
  IconWorld,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { SearchMode } from '@/types/searchMode';

import {
  AzureAIIcon,
  ClaudeIcon,
  DeepSeekIcon,
  MetaIcon,
  OpenAIIcon,
  XAIIcon,
} from '../Icons/providers';

interface Props {
  botInfo: {
    id: string;
    name: string;
    color: string;
  } | null;
  selectedModelName: string | undefined;
  selectedModelProvider?: string;
  selectedModelId?: string;
  isCustomAgent?: boolean;
  showSettings: boolean;
  onSettingsClick: () => void;
  onModelClick?: () => void;
  onClearAll?: () => void;
  userEmail?: string;
  hasMessages?: boolean;
  searchMode?: SearchMode;
  showChatbar?: boolean;
}

export const ChatTopbar = ({
  botInfo,
  selectedModelName,
  selectedModelProvider,
  selectedModelId,
  isCustomAgent = false,
  showSettings,
  onSettingsClick,
  onModelClick,
  onClearAll,
  userEmail,
  hasMessages = false,
  searchMode,
  showChatbar = false,
}: Props) => {
  const t = useTranslations();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showMenu]);

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
        return <ClaudeIcon {...iconProps} />;
      default:
        return null;
    }
  };

  return (
    <div className="sticky top-0 z-20 py-2 text-sm text-neutral-500 dark:text-neutral-200 transition-all duration-300 ease-in-out bg-white dark:bg-[#212121]">
      <div className="mr-8 px-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 transition-all duration-300">
        {/* Bot/Model Info */}
        <div className="flex items-center min-w-0 justify-center sm:justify-start">
          {botInfo && (
            <div className="flex items-center mr-2 shrink-0">
              <span
                className="font-semibold truncate sm:max-w-[200px]"
                style={{ color: botInfo.color }}
                title={`${botInfo.name} Bot`}
              >
                {botInfo.name} Bot
              </span>
              <span className="mx-2 text-white dark:text-white">|</span>
            </div>
          )}
          <div className="truncate min-w-0">
            <button
              className="flex items-center justify-center rounded-md transition-colors px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-transparent hover:border-neutral-300 dark:hover:border-neutral-600"
              onClick={onModelClick || onSettingsClick}
              aria-label={t('chat.selectModel')}
              title={t('chat.selectModel')}
            >
              {getProviderIcon(selectedModelProvider)}
              <span
                className="truncate font-bold dark:text-blue-50 text-gray-800 text-base ml-2"
                title={selectedModelName}
              >
                {selectedModelName || t('chat.selectModel')}
              </span>
              {!isCustomAgent && searchMode === SearchMode.INTELLIGENT && (
                <IconWorld
                  size={14}
                  className="ml-1.5 text-blue-600 dark:text-blue-400"
                  title={t('chat.privacyFocusedSearch')}
                />
              )}
              {!isCustomAgent && searchMode === SearchMode.AGENT && (
                <AzureAIIcon
                  className="ml-1.5 w-3.5 h-3.5 text-blue-600 dark:text-blue-400"
                  aria-label={t('chat.azureAIAgentMode')}
                />
              )}
              {isCustomAgent && (
                <AzureAIIcon
                  className="ml-1.5 w-3.5 h-3.5 text-blue-600 dark:text-blue-400"
                  aria-label={t('chat.customAgent')}
                />
              )}
              <IconChevronDown
                size={16}
                className="ml-1.5 opacity-60 text-black dark:text-white"
              />
            </button>
          </div>
        </div>

        {/* Controls - 3-dot menu */}
        <div className="flex items-center justify-center" ref={menuRef}>
          <div className="relative">
            <button
              className="p-1.5 rounded-md hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
              onClick={() => setShowMenu(!showMenu)}
              aria-label={t('common.menu')}
              title={t('common.menu')}
            >
              <IconDots size={20} className="text-black dark:text-white" />
            </button>

            {/* Dropdown menu */}
            {showMenu && hasMessages && (
              <div className="absolute right-0 top-full mt-1 z-10 w-48 rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-600 dark:bg-[#212121]">
                <div className="p-1">
                  {/* Clear option */}
                  <button
                    className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                    onClick={() => {
                      onClearAll?.();
                      setShowMenu(false);
                    }}
                  >
                    <IconClearAll
                      size={16}
                      className="text-neutral-600 dark:text-neutral-400 shrink-0"
                    />
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
