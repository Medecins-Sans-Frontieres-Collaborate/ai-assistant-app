'use client';

import { FC, useId } from 'react';

import { useTranslations } from 'next-intl';

import { useSettingsStore } from '@/client/stores/settingsStore';

// Mirrors the settingsStore clamp (20..VALIDATION_LIMITS.MAX_API_MESSAGES).
const CONTEXT_WINDOW_SLIDER = { min: 20, max: 200, step: 5 } as const;

/**
 * Store-driven slider for the per-request message window ("context window").
 * Deliberately self-contained (reads settingsStore directly) — the legacy
 * ChatSettings reducer/save plumbing is not extended for new settings.
 */
export const ContextWindowSlider: FC = () => {
  const t = useTranslations('contextWindow');
  const sliderId = useId();
  const contextWindowSize = useSettingsStore((s) => s.contextWindowSize);
  const setContextWindowSize = useSettingsStore((s) => s.setContextWindowSize);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label
          htmlFor={sliderId}
          className="text-sm font-medium text-black dark:text-gray-200"
        >
          {t('label')}
        </label>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t('value', { count: contextWindowSize })}
        </span>
      </div>
      <input
        id={sliderId}
        type="range"
        min={CONTEXT_WINDOW_SLIDER.min}
        max={CONTEXT_WINDOW_SLIDER.max}
        step={CONTEXT_WINDOW_SLIDER.step}
        value={contextWindowSize}
        onChange={(e) => setContextWindowSize(Number(e.target.value))}
        className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-gray-600 dark:accent-gray-400"
      />
      <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
        <span>{t('fewer')}</span>
        <span>{t('more')}</span>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
        {t('description')}
      </p>
    </div>
  );
};
