import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import {
  getFamilyVariants,
  getSeriesVersions,
  pickVariantTarget,
} from '@/lib/utils/app/modelSeries';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { useSettingsStore } from '@/client/stores/settingsStore';

interface VariantSectionProps {
  selectedModel: OpenAIModel;
  /** Selects a model from another variant of the same family (ModelSelect's handleModelSelect). */
  onSelectVariant: (model: OpenAIModel) => void;
}

/**
 * Variant switcher for family models — the second in-row axis next to the
 * Version chips (e.g. Standard/Mini/Nano for GPT, Opus/Sonnet/Haiku for
 * Claude, Standard/Reasoning for DeepSeek). Switching keeps the current
 * version when the target variant has it, else jumps to that variant's
 * representative.
 */
export const VariantSection: FC<VariantSectionProps> = ({
  selectedModel,
  onSelectVariant,
}) => {
  const t = useTranslations('modelSelect');
  // Same source the picker list renders from (the useSettings hook), so the
  // Variant section always matches what the list shows.
  const { models } = useSettings();
  const hiddenModelIds = useSettingsStore((s) => s.hiddenModelIds);

  const meta = useMemo(
    () => OpenAIModels[selectedModel.id as OpenAIModelID] ?? selectedModel,
    [selectedModel],
  );

  const variants = useMemo(() => {
    const hidden = new Set(hiddenModelIds);
    const members = getSeriesVersions(models, meta).filter(
      (m) => !hidden.has(m.id) || m.id === selectedModel.id,
    );
    // Keep the selected model's own variant present even when all its
    // versions are hidden, so the control never renders without an active
    // segment.
    if (!members.some((m) => m.id === selectedModel.id) && meta.series) {
      members.push(meta as OpenAIModel);
    }
    return getFamilyVariants(members);
  }, [models, hiddenModelIds, meta, selectedModel.id]);

  if (variants.length < 2) return null;

  const activeVariant = meta.variant ?? '';

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1.5">
        {t('variant.label')}
      </h4>
      <div
        role="group"
        aria-label={t('variant.label')}
        className="flex flex-wrap items-center gap-1"
      >
        {variants.map((variant) => {
          const isActive = activeVariant === variant.key;
          return (
            <button
              key={variant.key}
              type="button"
              onClick={() => {
                if (isActive) return;
                const target = pickVariantTarget(
                  variant.members,
                  meta.versionLabel,
                );
                if (target) onSelectVariant(target);
              }}
              aria-pressed={isActive}
              title={variant.members[0]?.name}
              className={`rounded-lg border px-2.5 py-1.5 min-h-[36px] text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                isActive
                  ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                  : 'border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              {variant.label || variant.members[0]?.name}
            </button>
          );
        })}
      </div>
    </div>
  );
};
