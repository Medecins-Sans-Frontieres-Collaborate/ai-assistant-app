'use client';

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { ActiveFile } from '@/types/chat';

import { useConversationStore } from '@/client/stores/conversationStore';

/**
 * Panel displaying active files for the current conversation.
 * Shows file status, token counts, and provides pin/remove controls.
 */
export function ActiveFilesPanel() {
  // Use useShallow to prevent "getSnapshot should be cached" React 19 warning.
  // This ensures stable object references when underlying values haven't changed.
  const {
    selectedConversation,
    deactivateFile,
    clearAllActiveFiles,
    setPinned,
  } = useConversationStore(
    useShallow((state) => ({
      selectedConversation:
        state.conversations.find(
          (c) => c.id === state.selectedConversationId,
        ) || null,
      deactivateFile: state.deactivateFile,
      clearAllActiveFiles: state.clearAllActiveFiles,
      setPinned: state.setPinned,
    })),
  );

  const files = useMemo<ActiveFile[]>(
    () => selectedConversation?.activeFiles ?? [],
    [selectedConversation?.activeFiles],
  );

  const totalTokens = useMemo(
    () =>
      files.reduce(
        (sum, f) => sum + (f.processedContent?.tokenEstimate || 0),
        0,
      ),
    [files],
  );

  if (!selectedConversation) return null;

  return (
    <div className="w-full border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1c1c1c] p-2">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200">
          Active Files ({files.length})
          {totalTokens > 0 ? ` • ${totalTokens} tok` : ''}
        </div>
        {files.length > 0 && (
          <button
            onClick={() => clearAllActiveFiles(selectedConversation.id)}
            className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Clear All
          </button>
        )}
      </div>
      {files.length === 0 ? (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          No active files
        </div>
      ) : (
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
              {f.status === 'processing' && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-yellow-100 text-yellow-700">
                  processing
                </span>
              )}
              {f.status === 'ready' && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-green-100 text-green-700">
                  ready
                </span>
              )}
              {f.status === 'error' && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-red-100 text-red-700">
                  error
                </span>
              )}
              {f.processedContent?.tokenEstimate ? (
                <span className="text-[10px] text-gray-500">
                  {f.processedContent.tokenEstimate} tok
                </span>
              ) : null}
              <button
                onClick={() =>
                  setPinned(selectedConversation.id, f.id, !f.pinned)
                }
                className={`text-[10px] px-1 py-0.5 rounded border ${
                  f.pinned
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300'
                }`}
                title="Pin"
              >
                {f.pinned ? 'Pinned' : 'Pin'}
              </button>
              <button
                onClick={() => deactivateFile(selectedConversation.id, f.id)}
                className="text-[10px] px-1 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
