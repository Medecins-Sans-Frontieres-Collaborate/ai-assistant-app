import { IconCalendar, IconChevronLeft } from '@tabler/icons-react';
import React, { FC } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { modelIdToLocaleKey } from '@/lib/utils/app/locales';
import { formatKnowledgeCutoff } from '@/lib/utils/shared/formatKnowledgeCutoff';

import { OpenAIModel } from '@/types/openai';
import { OrganizationAgent } from '@/types/organizationAgent';

import { Tooltip } from '@/components/UI/Tooltip';

import { ModelProviderIcon } from './ModelProviderIcon';

import { getIconComponent } from '@/lib/organizationAgents';

interface ModelHeaderProps {
  selectedModel: OpenAIModel;
  modelConfig?: OpenAIModel | null;
  setMobileView: (view: 'list' | 'details') => void;
  organizationAgent?: OrganizationAgent;
  /** When true, uses light text colors for visibility over a background image */
  hasBackgroundImage?: boolean;
}

export const ModelHeader: FC<ModelHeaderProps> = ({
  selectedModel,
  modelConfig,
  setMobileView,
  organizationAgent,
  hasBackgroundImage = false,
}) => {
  const t = useTranslations();
  const locale = useLocale();

  // Defensive check - should not happen if parent guards correctly
  if (!selectedModel) {
    return null;
  }

  // Get localized model data if available
  const localeKey = modelIdToLocaleKey(selectedModel.id);
  const localizedName = t.has(`models.${localeKey}.name`)
    ? t(`models.${localeKey}.name`)
    : selectedModel.name;
  const localizedDescription = t.has(`models.${localeKey}.description`)
    ? t(`models.${localeKey}.description`)
    : selectedModel.description || modelConfig?.description;

  // Get knowledge cutoff display - format ISO date with locale, or use translation for special cases
  let knowledgeCutoffDisplay: string | null = null;
  if (modelConfig?.knowledgeCutoffDate) {
    // Has ISO date - format with user's locale
    knowledgeCutoffDisplay = formatKnowledgeCutoff(
      modelConfig.knowledgeCutoffDate,
      locale,
    );
  } else if (modelConfig?.isAgent) {
    // Special case for agent models (real-time web search)
    knowledgeCutoffDisplay = t('modelSelect.knowledgeCutoff.realtime');
  }

  // Get localized model type

  // Text styles based on whether there's a background image
  const textShadow = hasBackgroundImage
    ? { textShadow: '0 2px 4px rgba(0,0,0,0.5)' }
    : undefined;
  const titleClass = hasBackgroundImage
    ? 'text-white'
    : 'text-gray-900 dark:text-white';
  const descriptionClass = hasBackgroundImage
    ? 'text-white/90'
    : 'text-gray-600 dark:text-gray-400';
  const backButtonClass = hasBackgroundImage
    ? 'text-gray-300 hover:text-white'
    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100';

  // Hide model type badge for org agents (not meaningful)
  const showModelTypeBadge = !organizationAgent;

  return (
    <div>
      <button
        onClick={() => setMobileView('list')}
        className={`md:hidden flex items-center gap-2 text-sm mb-4 ${backButtonClass}`}
      >
        <IconChevronLeft size={16} />
        {t('modelSelect.header.backToModels')}
      </button>

      <div className="flex items-center gap-2 md:gap-3 mb-2">
        {/* Only show icon for non-background-image cases */}
        {organizationAgent && !hasBackgroundImage ? (
          (() => {
            const IconComp = getIconComponent(organizationAgent.icon);
            return (
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center"
                style={{
                  backgroundColor: `color-mix(in oklab, ${organizationAgent.color} 14%, transparent)`,
                }}
              >
                <IconComp
                  size={24}
                  style={{ color: organizationAgent.color }}
                />
              </div>
            );
          })()
        ) : !organizationAgent ? (
          <ModelProviderIcon
            provider={selectedModel.provider || modelConfig?.provider}
            size="lg"
          />
        ) : null}
        <h2
          className={`text-2xl md:text-3xl font-bold ${titleClass}`}
          style={textShadow}
        >
          {localizedName}
        </h2>
      </div>
      {(() => {
        // Bold the first sentence of the description so users get the
        // headline takeaway at a glance without reading the whole block.
        const desc = localizedDescription || '';
        const match = desc.match(/^([^.!?]+[.!?])(\s+)?(.*)$/s);
        const lead = match?.[1]?.trim();
        const rest = match?.[3]?.trim();
        return (
          <p
            className={`text-sm md:text-base ${organizationAgent?.maintainedBy ? 'mb-2' : 'mb-3'} ${descriptionClass} ${hasBackgroundImage ? 'max-w-lg' : ''}`}
            style={textShadow}
          >
            {lead && rest ? (
              <>
                <span
                  className={
                    hasBackgroundImage
                      ? 'font-semibold text-white'
                      : 'font-semibold text-gray-900 dark:text-white'
                  }
                >
                  {lead}
                </span>{' '}
                {rest}
              </>
            ) : (
              desc
            )}
          </p>
        );
      })()}

      {organizationAgent?.maintainedBy && (
        <p
          className={`text-xs mb-3 ${hasBackgroundImage ? 'text-white/70' : 'text-gray-500 dark:text-gray-400'}`}
          style={textShadow}
        >
          {t('modelSelect.maintainedBy')}{' '}
          <span
            className={
              hasBackgroundImage
                ? 'text-white/90 font-medium'
                : 'text-gray-700 dark:text-gray-300 font-medium'
            }
          >
            {organizationAgent.maintainedBy}
          </span>
        </p>
      )}

      {/* The modelType badge ("omni", "reasoning", etc.) was removed — it
          was jargon that didn't communicate to users. Tagline + description
          carry that meaning now. Knowledge cutoff stays because dates are
          concrete and useful for research / news use cases. */}
      {showModelTypeBadge && knowledgeCutoffDisplay && (
        <div className="flex items-center gap-2 flex-wrap">
          <Tooltip content={t('modelSelect.header.knowledgeCutoffLabel')}>
            <span className="inline-flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 cursor-help">
              <IconCalendar size={14} />
              {knowledgeCutoffDisplay}
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
};
