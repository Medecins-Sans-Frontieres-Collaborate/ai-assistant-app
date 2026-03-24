'use client';

import {
  IconAlertTriangle,
  IconDownload,
  IconRefresh,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { FC, useCallback, useReducer, useState } from 'react';

import { useTranslations } from 'next-intl';

import { CONV_PREFIX } from '@/lib/utils/app/storage/perConversationStorage';
import {
  clearAllQuarantined,
  getQuarantinedItems,
  markRecoveryAttempted,
  removeQuarantinedItem,
} from '@/lib/utils/app/storage/quarantineStore';
import { attemptRecovery } from '@/lib/utils/app/storage/recoveryService';

import { QuarantinedItem } from '@/types/storage';

import { useConversationStore } from '@/client/stores/conversationStore';

interface QuarantineDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Dialog for reviewing and recovering quarantined conversations.
 */
export const QuarantineDialog: FC<QuarantineDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const t = useTranslations('quarantine');
  // Version counter to trigger re-reads after mutations (recovery/delete)
  const [, forceRefresh] = useReducer((x: number) => x + 1, 0);
  const [recoveryStatus, setRecoveryStatus] = useState<
    Record<string, 'success' | 'failed' | undefined>
  >({});

  const addConversation = useConversationStore(
    (state) => state.addConversation,
  );
  const updateConversation = useConversationStore(
    (state) => state.updateConversation,
  );
  const conversations = useConversationStore((state) => state.conversations);

  // Refresh items after recovery/delete operations
  const refreshItems = useCallback(() => {
    forceRefresh();
  }, []);

  if (!isOpen) return null;

  // Read items on each render when open (cheap localStorage read, avoids setState-in-effect)
  const items = getQuarantinedItems();

  const handleRecovery = (item: QuarantinedItem) => {
    const result = attemptRecovery(item.rawData);
    markRecoveryAttempted(item.id);

    if (result.recovered && result.conversation) {
      // Dedup: only add/update if recovered version is newer than existing
      const existing = conversations.find(
        (c) => c.id === result.conversation!.id,
      );
      if (existing) {
        const existingTime = existing.updatedAt
          ? new Date(existing.updatedAt).getTime()
          : 0;
        const recoveredTime = result.conversation.updatedAt
          ? new Date(result.conversation.updatedAt).getTime()
          : 0;
        if (recoveredTime > existingTime || existingTime === 0) {
          updateConversation(result.conversation.id, result.conversation);
        }
        // If existing is newer, skip — just remove from quarantine below
      } else {
        addConversation(result.conversation);
      }
      // Verify the conversation actually persisted before removing from quarantine
      const convKey = `${CONV_PREFIX}${result.conversation.id}`;
      if (localStorage.getItem(convKey)) {
        removeQuarantinedItem(item.id);
        setRecoveryStatus((prev) => ({ ...prev, [item.id]: 'success' }));
      } else {
        // Persistence failed (likely quota) — keep quarantine entry as safety net
        setRecoveryStatus((prev) => ({
          ...prev,
          [item.id]: 'failed',
        }));
      }
      refreshItems();
    } else {
      setRecoveryStatus((prev) => ({ ...prev, [item.id]: 'failed' }));
    }
  };

  const handleExport = (item: QuarantinedItem) => {
    const blob = new Blob([item.rawData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quarantined-${item.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = (id: string) => {
    removeQuarantinedItem(id);
    refreshItems();
  };

  const handleDeleteAll = () => {
    clearAllQuarantined();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="relative w-full max-w-lg rounded-xl bg-white dark:bg-[#171717] shadow-2xl border border-gray-200 dark:border-gray-700 max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-amber-100 dark:bg-amber-900/30 p-2">
              <IconAlertTriangle
                size={18}
                className="text-amber-600 dark:text-amber-400"
              />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
                {t('title')}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('itemCount', { count: items.length })}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <IconX size={16} className="text-gray-500" />
          </button>
        </div>

        {/* Items list */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
          {items.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-6">
              {t('noItems')}
            </p>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-gray-200 dark:border-gray-700 p-3"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-mono text-gray-600 dark:text-gray-400 truncate">
                      {t('itemId', { id: item.id })}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-500 mt-0.5">
                      {t('itemSource', {
                        date: new Date(item.quarantinedAt).toLocaleDateString(),
                        source: item.sourceKey,
                      })}
                    </p>
                  </div>
                  {recoveryStatus[item.id] === 'success' && (
                    <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                      {t('recovered')}
                    </span>
                  )}
                  {recoveryStatus[item.id] === 'failed' && (
                    <span className="text-xs text-red-600 dark:text-red-400 font-medium">
                      {t('recoveryFailed')}
                    </span>
                  )}
                </div>

                {/* Type badge */}
                {item.itemType && item.itemType !== 'conversation' && (
                  <p className="text-xs text-gray-400 dark:text-gray-500 mb-1 italic">
                    {item.itemType === 'folder'
                      ? t('folderData')
                      : t('backupData')}
                  </p>
                )}

                {/* Errors */}
                <div className="mb-2">
                  {item.errors.map((err, i) => (
                    <p
                      key={i}
                      className="text-xs text-red-600 dark:text-red-400"
                    >
                      {err}
                    </p>
                  ))}
                </div>

                {/* Actions */}
                <div className="flex gap-2">
                  {(!item.itemType || item.itemType === 'conversation') && (
                    <button
                      onClick={() => handleRecovery(item)}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                      disabled={recoveryStatus[item.id] === 'success'}
                    >
                      <IconRefresh size={12} />
                      {t('recover')}
                    </button>
                  )}
                  <button
                    onClick={() => handleExport(item)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <IconDownload size={12} />
                    {t('export')}
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
                  >
                    <IconTrash size={12} />
                    {t('delete')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {items.length > 0 && (
          <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-between">
            <button
              onClick={handleDeleteAll}
              className="text-xs text-red-600 dark:text-red-400 hover:underline"
            >
              {t('deleteAll')}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              {t('close')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
