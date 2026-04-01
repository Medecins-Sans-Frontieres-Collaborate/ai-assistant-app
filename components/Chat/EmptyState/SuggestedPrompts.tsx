'use client';

import React, { useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { suggestedPromptIcons } from '@/lib/data/prompts';

interface SuggestedPromptsProps {
  onSelectPrompt?: (prompt: string) => void;
  count?: number;
}

/** Ordered list of prompt keys matching the translation structure */
const PROMPT_KEYS = [
  'createDiagrams',
  'draftContent',
  'analyzeInformation',
  'planOrganize',
  'brainstormIdeas',
  'buildPresentations',
  'workWithCode',
  'decisionSupport',
  'summarizeSynthesize',
  'explainTopics',
  'createSchedules',
] as const;

type PromptKey = (typeof PROMPT_KEYS)[number];

/**
 * Display suggested prompts for new conversations.
 * Uses localized prompt titles and content from translations.
 */
export function SuggestedPrompts({
  onSelectPrompt,
  count = 3,
}: SuggestedPromptsProps) {
  const t = useTranslations('emptyState.suggestedPrompts');

  const displayedPrompts = useMemo(() => {
    return PROMPT_KEYS.slice(0, count).map((key) => ({
      key,
      title: t(`${key}.title`),
      prompt: t(`${key}.prompt`),
      icon: suggestedPromptIcons[key],
    }));
  }, [count, t]);

  return (
    <div className="flex overflow-x-auto sm:overflow-x-visible sm:flex-wrap sm:justify-center gap-2 sm:gap-3 max-w-5xl mx-auto px-1 pb-2 sm:pb-0 scrollbar-none">
      {displayedPrompts.map((prompt) => {
        const Icon = prompt.icon;

        return (
          <button
            key={prompt.key}
            className="group relative bg-white dark:bg-surface-dark text-black dark:text-white border border-gray-200 dark:border-gray-700 rounded-full px-3 sm:px-4 py-1.5 sm:py-2 text-center hover:border-gray-400 dark:hover:border-gray-600 hover:shadow-lg dark:hover:shadow-black/60 transition-all duration-200 ease-in-out flex-shrink-0"
            onClick={() => onSelectPrompt?.(prompt.prompt)}
          >
            {Icon && (
              <div className="flex flex-row rtl:flex-row-reverse items-center justify-center gap-2 whitespace-nowrap">
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 dark:bg-surface-dark-elevated flex-shrink-0 group-hover:bg-gray-200 dark:group-hover:bg-gray-700 transition-colors">
                  <Icon className="h-3.5 w-3.5 text-gray-700 dark:text-gray-300" />
                </div>
                <h3 className="font-medium text-sm text-gray-900 dark:text-gray-100">
                  {prompt.title}
                </h3>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
