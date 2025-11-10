'use client';

import React, { useMemo } from 'react';

import { suggestedPrompts } from '@/lib/data/prompts';

interface SuggestedPromptsProps {
  onSelectPrompt?: (prompt: string) => void;
  count?: number;
}

/**
 * Display suggested prompts for new conversations
 */
export function SuggestedPrompts({
  onSelectPrompt,
  count = 3,
}: SuggestedPromptsProps) {
  // Use first N prompts to avoid hydration mismatch from randomization
  const displayedPrompts = useMemo(() => {
    return suggestedPrompts.slice(0, count);
  }, [count]);

  return (
    <div className="hidden sm:flex sm:flex-wrap sm:justify-center gap-3 max-w-5xl mx-auto">
      {displayedPrompts.map((prompt, index) => {
        const Icon = prompt.icon;

        return (
          <button
            key={index}
            className="group relative bg-white dark:bg-[#1F1F1F] text-black dark:text-white border border-gray-200 dark:border-[#3F3F3F] rounded-full px-4 py-2 text-center hover:border-gray-400 dark:hover:border-[#555555] hover:shadow-lg dark:hover:shadow-[#0a0a0a]/60 transition-all duration-200 ease-in-out"
            onClick={() => onSelectPrompt?.(prompt.prompt)}
          >
            {Icon && (
              <div className="flex flex-row items-center justify-center gap-2 whitespace-nowrap">
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 dark:bg-[#2F2F2F] flex-shrink-0 group-hover:bg-gray-200 dark:group-hover:bg-[#3F3F3F] transition-colors">
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
