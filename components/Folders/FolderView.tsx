'use client';

import {
  IconCheck,
  IconDownload,
  IconEdit,
  IconFolder,
  IconFolderSymlink,
  IconMenu2,
  IconMessage,
  IconPlus,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useNewConversation } from '@/client/hooks/conversation/useNewConversation';
import { useUI } from '@/client/hooks/ui/useUI';

import { exportFolder } from '@/lib/utils/app/export/folderExport';

import { Conversation } from '@/types/chat';

import { FolderPicker } from '@/components/Sidebar/FolderPicker';
import { WORKFLOW_META } from '@/components/Workflows/registryMeta';

import { useUIStore } from '@/client/stores/uiStore';

interface FolderViewProps {
  folderId: string;
}

/** Most recently updated first; entries without a timestamp keep store order at the end. */
function byUpdatedDesc(a: Conversation, b: Conversation): number {
  const ta = a.updatedAt ? Date.parse(a.updatedAt) : NaN;
  const tb = b.updatedAt ? Date.parse(b.updatedAt) : NaN;
  if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  return tb - ta;
}

const ACTION_BTN =
  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-gray-200 dark:hover:bg-surface-dark-elevated';

/**
 * A folder opened in the main panel: its chats as a list, header actions
 * (rename / export / delete / new chat), and checkbox multi-select with
 * bulk "Move to…" and delete. Pure UI over the existing conversation and
 * folder state — no new persisted fields.
 *
 * Exits (closes itself) when the selected conversation changes, whichever
 * code path changed it, and when the folder no longer exists.
 */
export function FolderView({ folderId }: FolderViewProps) {
  const t = useTranslations();
  const { toggleChatbar } = useUI();
  const closeFolder = useUIStore((s) => s.closeFolder);
  const {
    conversations,
    selectedConversation,
    selectConversation,
    updateConversation,
    deleteConversation,
    folders,
    updateFolder,
    deleteFolder,
  } = useConversations();
  const startNewConversation = useNewConversation();

  const folder = folders.find((f) => f.id === folderId);
  const items = useMemo(
    () =>
      conversations.filter((c) => c.folderId === folderId).sort(byUpdatedDesc),
    [conversations, folderId],
  );

  // Any selection change means a chat was opened somewhere — leave the page.
  const selectedId = selectedConversation?.id ?? null;
  const selectionAtOpenRef = useRef(selectedId);
  useEffect(() => {
    if (selectedId !== selectionAtOpenRef.current) closeFolder();
  }, [selectedId, closeFolder]);

  // Folder deleted (here or in the sidebar) — nothing left to show.
  useEffect(() => {
    if (!folder) closeFolder();
  }, [folder, closeFolder]);

  // Rename
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const commitRename = () => {
    const name = draftName.trim();
    if (name && folder && name !== folder.name) updateFolder(folder.id, name);
    setIsRenaming(false);
  };

  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showMovePicker, setShowMovePicker] = useState(false);
  const moveButtonRef = useRef<HTMLButtonElement>(null);
  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds(allSelected ? new Set() : new Set(items.map((c) => c.id)));

  const handleBulkMove = (targetFolderId: string | null) => {
    selectedIds.forEach((id) =>
      updateConversation(id, { folderId: targetFolderId }),
    );
    setSelectedIds(new Set());
  };
  const handleBulkDelete = () => {
    if (
      !window.confirm(
        t('folderView.confirmDeleteChats', { count: selectedIds.size }),
      )
    )
      return;
    selectedIds.forEach((id) => deleteConversation(id));
    setSelectedIds(new Set());
  };

  const handleOpen = (id: string) => {
    closeFolder();
    selectConversation(id);
  };
  const handleNewChat = () => {
    // Close first: the reused-empty-chat path may keep the same selection,
    // in which case the selection watcher above would not fire.
    closeFolder();
    startNewConversation(folderId);
  };
  const handleExport = () => {
    if (!folder) return;
    try {
      exportFolder(folder, conversations);
      toast.success(
        t('Folder exported with {count} conversations', {
          count: items.length,
        }),
      );
    } catch (error) {
      console.error('Error exporting folder:', error);
      toast.error(t('Failed to export folder'));
    }
  };
  const handleDeleteFolder = () => {
    if (!folder) return;
    if (!window.confirm(t('Are you sure you want to delete this folder?')))
      return;
    // The store un-folders the chats (keeps them); the effect above closes.
    deleteFolder(folder.id);
  };

  if (!folder) return null;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-white dark:bg-surface-dark"
      data-testid="folder-view"
    >
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2.5 dark:border-gray-700">
        <button
          type="button"
          onClick={toggleChatbar}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-surface-dark-elevated md:hidden"
          aria-label={t('sidebar.expandSidebar')}
        >
          <IconMenu2 size={20} />
        </button>
        <IconFolder
          size={20}
          aria-hidden
          className="shrink-0 text-gray-500 dark:text-gray-400"
        />
        {isRenaming ? (
          <input
            type="text"
            value={draftName}
            autoFocus
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') setIsRenaming(false);
            }}
            aria-label={t('folderView.renameLabel')}
            className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm font-semibold text-gray-900 focus:border-gray-500 focus:outline-none dark:border-gray-600 dark:bg-surface-dark dark:text-gray-100"
          />
        ) : (
          <h1
            className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-900 dark:text-gray-100"
            title={folder.name}
          >
            {folder.name}
            <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
              {t('folderView.chatCount', { count: items.length })}
            </span>
          </h1>
        )}

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleNewChat}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
          >
            <IconPlus size={16} />
            <span className="hidden sm:inline">{t('folderView.newChat')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setDraftName(folder.name);
              setIsRenaming(true);
            }}
            className={ACTION_BTN}
            title={t('folderView.rename')}
            aria-label={t('folderView.rename')}
          >
            <IconEdit size={16} />
          </button>
          <button
            type="button"
            onClick={handleExport}
            className={ACTION_BTN}
            title={t('Export folder')}
            aria-label={t('Export folder')}
          >
            <IconDownload size={16} />
          </button>
          <button
            type="button"
            onClick={handleDeleteFolder}
            className={`${ACTION_BTN} text-red-600 dark:text-red-400`}
            title={t('folderView.deleteFolder')}
            aria-label={t('folderView.deleteFolder')}
          >
            <IconTrash size={16} />
          </button>
          <button
            type="button"
            onClick={closeFolder}
            className={ACTION_BTN}
            title={t('folderView.close')}
            aria-label={t('folderView.close')}
          >
            <IconX size={16} />
          </button>
        </div>
      </div>

      {/* Selection toolbar */}
      {items.length > 0 && (
        <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2 text-sm dark:border-gray-700">
          <label className="flex cursor-pointer items-center gap-2 text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label={t('folderView.selectAll')}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600"
            />
            {selectedIds.size > 0
              ? t('folderView.selectedCount', { count: selectedIds.size })
              : t('folderView.selectAll')}
          </label>
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-1">
              <button
                ref={moveButtonRef}
                type="button"
                onClick={() => setShowMovePicker(true)}
                className={ACTION_BTN}
              >
                <IconFolderSymlink size={16} />
                {t('folderView.moveTo')}
              </button>
              <button
                type="button"
                onClick={handleBulkDelete}
                className={`${ACTION_BTN} text-red-600 dark:text-red-400`}
              >
                <IconTrash size={16} />
                {t('folderView.deleteSelected')}
              </button>
              <FolderPicker
                triggerRef={moveButtonRef}
                isOpen={showMovePicker}
                onClose={() => setShowMovePicker(false)}
                folders={folders}
                value={folderId}
                onSelect={handleBulkMove}
              />
            </div>
          )}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <IconFolder
              size={40}
              aria-hidden
              className="text-gray-300 dark:text-gray-600"
            />
            <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {t('folderView.emptyTitle')}
            </p>
            <p className="max-w-sm text-sm text-gray-500 dark:text-gray-400">
              {t('folderView.emptyHint')}
            </p>
            <button
              type="button"
              onClick={handleNewChat}
              className="mt-1 flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              <IconPlus size={16} />
              {t('folderView.newChat')}
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {items.map((conversation) => {
              const name = conversation.name || t('New Conversation');
              const meta =
                conversation.conversationType &&
                WORKFLOW_META[conversation.conversationType];
              const Icon = meta ? meta.icon : IconMessage;
              const isCurrent = conversation.id === selectedId;
              const checked = selectedIds.has(conversation.id);
              return (
                <li
                  key={conversation.id}
                  className={`flex items-center gap-3 px-4 ${
                    checked ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(conversation.id)}
                    aria-label={t('folderView.selectChat', { name })}
                    className="h-4 w-4 shrink-0 rounded border-gray-300 dark:border-gray-600"
                  />
                  <button
                    type="button"
                    onClick={() => handleOpen(conversation.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-surface-dark-elevated"
                    aria-current={isCurrent ? 'true' : undefined}
                  >
                    <Icon
                      size={16}
                      aria-hidden
                      className="shrink-0 text-gray-500 dark:text-gray-400"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100"
                        title={name}
                      >
                        {name}
                      </span>
                      <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                        {t('folderView.messageCount', {
                          count: conversation.messages.length,
                        })}
                        {conversation.updatedAt && (
                          <>
                            {' · '}
                            {new Date(conversation.updatedAt).toLocaleString()}
                          </>
                        )}
                      </span>
                    </span>
                    {isCurrent && (
                      <IconCheck
                        size={16}
                        aria-hidden
                        className="shrink-0 text-blue-500"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
