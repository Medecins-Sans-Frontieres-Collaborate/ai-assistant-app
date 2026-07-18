'use client';

import { IconBrain, IconTrash } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useFormatter, useTranslations } from 'next-intl';

import { useMemoryStore } from '@/client/stores/memoryStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * "Memories" settings section: user opt-in toggle for cross-conversation
 * memories plus management of the stored entries. Visibility is gated by the
 * LaunchDarkly `enableMemories` flag in SettingsSidebar; the section itself
 * always renders what is stored so users can review and delete their data
 * even after opting out.
 */
export const MemoriesSection: FC = () => {
  const t = useTranslations('memories');
  const format = useFormatter();

  const memoriesEnabled = useSettingsStore((s) => s.memoriesEnabled);
  const setMemoriesEnabled = useSettingsStore((s) => s.setMemoriesEnabled);
  const memories = useMemoryStore((s) => s.memories);
  const deleteMemory = useMemoryStore((s) => s.deleteMemory);
  const clearMemories = useMemoryStore((s) => s.clearMemories);

  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Don't leave the destructive confirm armed across list-empty transitions
  // (e.g. last memory deleted per-item, then a new one auto-extracted).
  // Render-time state adjustment — the lint config disallows setState in effects.
  if (showClearConfirm && memories.length === 0) {
    setShowClearConfirm(false);
  }

  const clearConfirmVisible = showClearConfirm && memories.length > 0;

  const formatDate = (iso: string): string => {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime())
      ? ''
      : format.dateTime(parsed, { dateStyle: 'short' });
  };

  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <IconBrain size={24} className="text-black dark:text-white" />
        <h2 className="text-xl font-bold text-black dark:text-white">
          {t('title')}
        </h2>
      </div>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        {t('description')}
      </p>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-gray-600 dark:accent-gray-400"
          checked={memoriesEnabled}
          onChange={(e) => setMemoriesEnabled(e.target.checked)}
        />
        <span>
          <span className="block text-sm text-black dark:text-gray-200">
            {t('enableToggle')}
          </span>
          {/* Transparent data handling: where memories live and how they're used. */}
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {t('privacyNote')}
          </span>
        </span>
      </label>

      <div className="mt-6">
        {memories.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('empty')}
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {memories.map((memory) => (
                <li
                  key={memory.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm text-black dark:text-gray-200">
                      {memory.text}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {t('savedOn', { date: formatDate(memory.updatedAt) })}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteMemory(memory.id)}
                    aria-label={t('deleteMemory')}
                    title={t('deleteMemory')}
                    className="flex-shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-red-400"
                  >
                    <IconTrash size={16} />
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-4">
              {clearConfirmVisible ? (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-black dark:text-gray-200">
                    {t('clearAllConfirmQuestion')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      clearMemories();
                      setShowClearConfirm(false);
                    }}
                    className="text-sm font-semibold text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  >
                    {t('clearAllConfirm')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowClearConfirm(false)}
                    className="text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    {t('cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowClearConfirm(true)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-gray-700 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  {t('clearAll')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
