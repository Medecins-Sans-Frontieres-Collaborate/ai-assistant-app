'use client';

import {
  IconBraces,
  IconSparkles,
  IconVolume,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useTones } from '@/client/hooks/settings/useTones';

import { TabNavigation } from '@/components/UI/TabNavigation';

import { ExtractionRecipesTab } from './ExtractionRecipesTab';
import { PromptsTab } from './PromptsTab';
import { TonesTab } from './TonesTab';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

type CustomizationTab = 'prompts' | 'tones' | 'recipes';

interface CustomizationsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CustomizationsModal({
  isOpen,
  onClose,
}: CustomizationsModalProps) {
  const t = useTranslations();
  const [activeTab, setActiveTab] = useState<CustomizationTab>('prompts');

  // Get data directly from stores - no prop drilling!
  const { prompts } = useSettings();
  const { tones } = useTones();
  const { folders } = useConversations();
  const extractionRecipes = useSettingsStore((s) => s.extractionRecipes);

  // Honour an externally requested initial tab (set by the recipe picker
  // when the user clicks "Create new recipe…"). Cleared after honouring so
  // the next sidebar-driven open lands on the default Prompts tab.
  const requestedInitialTab = useUIStore((s) => s.customizationsInitialTab);
  const setCustomizationsInitialTab = useUIStore(
    (s) => s.setCustomizationsInitialTab,
  );

  useEffect(() => {
    if (isOpen && requestedInitialTab) {
      // Defer the state writes to a microtask so React doesn't see them as
      // a synchronous cascade off the same render that triggered the effect.
      queueMicrotask(() => {
        setActiveTab(requestedInitialTab);
        setCustomizationsInitialTab(null);
      });
    }
  }, [isOpen, requestedInitialTab, setCustomizationsInitialTab]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in-fast"
      onClick={onClose}
    >
      <div
        className="relative w-full h-full max-h-[90vh] max-w-[1400px] md:h-[85vh] bg-white dark:bg-[#212121] rounded-xl shadow-2xl overflow-hidden flex flex-col animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Tabs */}
        <div className="flex-shrink-0 px-4 md:px-6 py-3 md:py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-3 md:mb-4">
            <div className="flex-1 min-w-0 mr-4">
              <h3 className="text-lg md:text-xl font-semibold text-gray-900 dark:text-white truncate">
                {t('Quick Actions')}
              </h3>
              <p className="hidden sm:block text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('Type / in chat to access your prompts')}
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              <IconX size={20} />
            </button>
          </div>

          {/* Tab Navigation with Sliding Animation */}
          <TabNavigation
            tabs={[
              {
                id: 'prompts',
                label: (
                  <>
                    <span className="hidden sm:inline">{t('Prompts')}</span>
                    <span className="sm:hidden">
                      <IconSparkles size={16} />
                    </span>
                    <span className="ml-1">({prompts.length})</span>
                  </>
                ),
                icon: <IconSparkles size={16} className="hidden sm:block" />,
                width: '150px',
              },
              {
                id: 'tones',
                label: (
                  <>
                    <span className="hidden sm:inline">{t('Tones')}</span>
                    <span className="sm:hidden">
                      <IconVolume size={16} />
                    </span>
                    <span className="ml-1">({tones.length})</span>
                  </>
                ),
                icon: <IconVolume size={16} className="hidden sm:block" />,
                width: '150px',
              },
              {
                id: 'recipes',
                label: (
                  <>
                    <span className="hidden sm:inline">
                      {t('extraction.section')}
                    </span>
                    <span className="sm:hidden">
                      <IconBraces size={16} />
                    </span>
                    <span className="ml-1">({extractionRecipes.length})</span>
                  </>
                ),
                icon: <IconBraces size={16} className="hidden sm:block" />,
                width: '180px',
              },
            ]}
            activeTab={activeTab}
            onTabChange={(tab) => setActiveTab(tab as CustomizationTab)}
          />
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'prompts' && (
            <PromptsTab
              prompts={prompts}
              folders={folders.filter((f) => f.type === 'prompt')}
              onClose={onClose}
            />
          )}

          {activeTab === 'tones' && (
            <TonesTab
              tones={tones}
              folders={folders.filter((f) => f.type === 'tone')}
              onClose={onClose}
            />
          )}

          {activeTab === 'recipes' && <ExtractionRecipesTab />}
        </div>
      </div>
    </div>
  );
}
