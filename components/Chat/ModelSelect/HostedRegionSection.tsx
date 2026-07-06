import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { UserRegion } from '@/lib/utils/shared/region';

import { Conversation } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface HostedRegionSectionProps {
  selectedModel: OpenAIModel;
  selectedConversation: Conversation | null;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
}

/**
 * Per-conversation hosting-region choice (US users, dually-hosted models).
 *
 * EU users never see this — the server pins their chat to EU regardless
 * (resolveChatRegion), and the picker carries the blanket residency note.
 * US users on an EU-only model get a plain-prose line instead of a control:
 * there is only one instance to use.
 */
export const HostedRegionSection: FC<HostedRegionSectionProps> = ({
  selectedModel,
  selectedConversation,
  updateConversation,
}) => {
  const t = useTranslations('modelSelect.hostedRegion');
  const userRegion = useSettingsStore((s) => s.userRegion);
  const { models } = useSettings();

  // The live list entry carries runtime discovery data (hostedIn) that the
  // conversation's model snapshot lacks.
  const hostedIn = useMemo(
    () => models.find((m) => m.id === selectedModel.id)?.hostedIn,
    [models, selectedModel.id],
  );

  if (userRegion !== 'US' || !hostedIn || hostedIn.length === 0) return null;

  const isDual = hostedIn.includes('US') && hostedIn.includes('EU');
  const euOnly = !hostedIn.includes('US');

  if (!isDual && !euOnly) return null;

  if (euOnly) {
    return (
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {t('euOnlyNote', { name: selectedModel.name })}
      </p>
    );
  }

  const current: UserRegion =
    selectedConversation?.hostedRegion === 'EU' ? 'EU' : 'US';

  const setRegion = (region: UserRegion) => {
    if (!selectedConversation) return;
    updateConversation(selectedConversation.id, { hostedRegion: region });
  };

  const optionClass = (active: boolean) =>
    `px-3 py-1.5 min-h-[36px] rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
      active
        ? 'bg-blue-600 text-white dark:bg-blue-500'
        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
    }`;

  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-gray-900 dark:text-white">
          {t('label')}
        </span>
        <div
          role="group"
          aria-label={t('label')}
          className="inline-flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 gap-0.5"
        >
          {/* Region codes are proper nouns, not translated. */}
          {(['US', 'EU'] as const).map((region) => (
            <button
              key={region}
              type="button"
              onClick={() => setRegion(region)}
              aria-pressed={current === region}
              className={optionClass(current === region)}
            >
              {region}
            </button>
          ))}
        </div>
      </div>
      {/* Transparent consequences: say where the conversation is processed. */}
      <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
        {t('processedIn', { region: current })}
      </p>
    </div>
  );
};
