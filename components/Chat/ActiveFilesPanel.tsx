'use client';

import { IconChevronDown, IconFiles, IconRefresh } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useTranslations } from 'next-intl';

import { ActiveFile } from '@/types/chat';

import { useConversationStore } from '@/client/stores/conversationStore';

/**
 * CRITICAL: Stable reference for empty state.
 * Returning `[]` inside a selector creates a NEW array every time,
 * which defeats useShallow and causes infinite re-renders.
 */
const EMPTY_FILES: ActiveFile[] = [];

/**
 * Panel displaying active files for the current conversation.
 * Dynamically imported in Chat.tsx to avoid HMR issues.
 */
export function ActiveFilesPanel() {
  const t = useTranslations('activeFiles');
  const [isCollapsed, setIsCollapsed] = useState(false);

  // SAFE: Primitive selector - only re-renders when ID changes
  const selectedConversationId = useConversationStore(
    (state) => state.selectedConversationId,
  );

  // FIXED: Returns STABLE reference (EMPTY_FILES) when empty
  const files = useConversationStore(
    useShallow((state) => {
      if (!state.selectedConversationId) return EMPTY_FILES;
      const conv = state.conversations.find(
        (c) => c.id === state.selectedConversationId,
      );
      return conv?.activeFiles ?? EMPTY_FILES;
    }),
  );

  // FIXED: Return primitive (number), not object
  const tokenBudget = useConversationStore((state) => {
    if (!state.selectedConversationId) return 8000;
    const conv = state.conversations.find(
      (c) => c.id === state.selectedConversationId,
    );
    return conv?.activeFilesTokenBudget ?? 8000;
  });

  // SAFE: Action selectors are stable function references
  const deactivateFile = useConversationStore((state) => state.deactivateFile);
  const clearAllActiveFiles = useConversationStore(
    (state) => state.clearAllActiveFiles,
  );
  const setPinned = useConversationStore((state) => state.setPinned);
  const activateFile = useConversationStore((state) => state.activateFile);

  // Compute totals from stable files array
  const totalTokens = files.reduce(
    (sum, f) => sum + (f.processedContent?.tokenEstimate || 0),
    0,
  );
  const budgetUsedPercent = Math.min(100, (totalTokens / tokenBudget) * 100);
  const budgetStatus =
    budgetUsedPercent > 100
      ? 'exceeded'
      : budgetUsedPercent > 85
        ? 'warning'
        : 'normal';

  // SAFE: Uses closure over stable ID
  const handleRetryProcessing = useCallback(
    (file: ActiveFile) => {
      if (!selectedConversationId) return;
      deactivateFile(selectedConversationId, file.id);
      const newId = `${file.url}-${Date.now()}`;
      activateFile(selectedConversationId, {
        ...file,
        id: newId,
        status: 'idle',
        processedContent: undefined,
      });
    },
    [selectedConversationId, deactivateFile, activateFile],
  );

  // Handle null state internally - render nothing if no files
  if (!selectedConversationId || files.length === 0) return null;

  return (
    <div className="w-full border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1c1c1c]">
      {/* Collapsible Header */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full flex items-center justify-between p-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        aria-expanded={!isCollapsed}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
          <IconFiles size={16} />
          <span>
            {t('title')} ({files.length})
          </span>
          {totalTokens > 0 && (
            <span className="text-gray-500 dark:text-gray-400">
              {totalTokens.toLocaleString()} {t('tokens')}
            </span>
          )}
        </div>
        <IconChevronDown
          size={16}
          className={`text-gray-500 transition-transform duration-200 ${
            isCollapsed ? '' : 'rotate-180'
          }`}
        />
      </button>

      {/* Collapsible Content */}
      {!isCollapsed && (
        <div className="p-2 pt-0 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Token Budget Bar */}
          <div className="mb-2">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
              <span>{t('tokenUsage')}</span>
              <span>
                {totalTokens.toLocaleString()} / {tokenBudget.toLocaleString()}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  budgetStatus === 'exceeded'
                    ? 'bg-red-500'
                    : budgetStatus === 'warning'
                      ? 'bg-yellow-500'
                      : 'bg-blue-500'
                }`}
                style={{ width: `${Math.min(100, budgetUsedPercent)}%` }}
              />
            </div>
          </div>

          {/* Clear All Button */}
          <div className="flex justify-end mb-2">
            <button
              onClick={() => clearAllActiveFiles(selectedConversationId)}
              className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 transition-colors"
            >
              {t('clearAll')}
            </button>
          </div>

          {/* File List */}
          <div className="flex flex-wrap gap-2">
            {files.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 px-2 py-1 rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
              >
                <span
                  className="text-xs text-gray-800 dark:text-gray-200 max-w-[180px] truncate"
                  title={f.originalFilename}
                >
                  {f.originalFilename}
                </span>

                {/* Status Badges */}
                {f.status === 'processing' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300">
                    {t('processing')}
                  </span>
                )}
                {f.status === 'ready' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">
                    {t('ready')}
                  </span>
                )}
                {f.status === 'error' && (
                  <>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300">
                      {t('error')}
                    </span>
                    <button
                      onClick={() => handleRetryProcessing(f)}
                      className="text-[10px] px-1.5 py-0.5 rounded border border-red-300 dark:border-red-700
                        text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30
                        min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0
                        flex items-center justify-center transition-colors"
                      title={t('retry')}
                    >
                      <IconRefresh size={12} className="md:mr-1" />
                      <span className="hidden md:inline">{t('retry')}</span>
                    </button>
                  </>
                )}

                {/* Token Count */}
                {f.processedContent?.tokenEstimate ? (
                  <span className="text-[10px] text-gray-500 dark:text-gray-400">
                    {f.processedContent.tokenEstimate.toLocaleString()}{' '}
                    {t('tokens')}
                  </span>
                ) : null}

                {/* Pin Button */}
                <button
                  onClick={() =>
                    setPinned(selectedConversationId, f.id, !f.pinned)
                  }
                  className={`text-[10px] px-2 py-1.5 md:px-1 md:py-0.5 rounded border
                    min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0
                    flex items-center justify-center transition-colors ${
                      f.pinned
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  title={f.pinned ? t('pinned') : t('pin')}
                >
                  {f.pinned ? t('pinned') : t('pin')}
                </button>

                {/* Remove Button */}
                <button
                  onClick={() => deactivateFile(selectedConversationId, f.id)}
                  className="text-[10px] px-2 py-1.5 md:px-1 md:py-0.5 rounded border border-gray-300 dark:border-gray-600
                    hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300
                    min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0
                    flex items-center justify-center transition-colors"
                  title={t('removeFromContext')}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
