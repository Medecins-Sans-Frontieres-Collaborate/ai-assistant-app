'use client';

import {
  IconChevronRight,
  IconDots,
  IconDownload,
  IconEdit,
  IconFolder,
  IconShare2,
  IconTrash,
} from '@tabler/icons-react';
import { memo, useCallback, useRef, useState } from 'react';

import { Conversation } from '@/types/chat';

import { DropdownPortal } from '@/components/UI/DropdownPortal';
import { WORKFLOW_META } from '@/components/Workflows/registryMeta';

import { FolderPicker } from './FolderPicker';

interface ConversationItemProps {
  conversation: Conversation;
  /** Pre-computed in Sidebar so changing selection only re-renders two rows. */
  isSelected: boolean;
  handleSelectConversation: (id: string) => void;
  handleDeleteConversation: (id: string, e: React.MouseEvent) => void;
  handleMoveToFolder: (conversationId: string, folderId: string | null) => void;
  /** Creates a folder with `name` and moves the conversation into it. */
  handleCreateFolderAndMove?: (conversationId: string, name: string) => void;
  handleRenameConversation: (id: string, currentName: string) => void;
  handleExportConversation: (conversation: Conversation) => void;
  /** Absent when sharing is unavailable (flag off / M365 not connected). */
  handleShareConversation?: (conversation: Conversation) => void;
  folders: any[];
  t: (key: string) => string;
}

function ConversationItemInner({
  conversation,
  isSelected,
  handleSelectConversation,
  handleDeleteConversation,
  handleMoveToFolder,
  handleCreateFolderAndMove,
  handleRenameConversation,
  handleExportConversation,
  handleShareConversation,
  folders,
  t,
}: ConversationItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState(
    conversation.name || t('New Conversation'),
  );
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const handleCloseMenu = useCallback(() => setShowMenu(false), []);
  const handleCloseFolderPicker = useCallback(
    () => setShowFolderPicker(false),
    [],
  );

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('conversationId', conversation.id);
  };

  const handleSaveName = () => {
    if (editingName.trim()) {
      handleRenameConversation(conversation.id, editingName.trim());
    }
    setIsEditing(false);
  };

  return (
    <div
      draggable={!isEditing}
      onDragStart={handleDragStart}
      role="button"
      tabIndex={0}
      aria-selected={isSelected}
      className={`group flex items-center gap-2 rounded p-2 cursor-pointer transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        isSelected
          ? 'bg-gray-200 dark:bg-gray-700'
          : 'hover:bg-gray-100 dark:hover:bg-gray-800 hover:shadow-sm'
      }`}
      onClick={() =>
        !isEditing &&
        !showMenu &&
        !showFolderPicker &&
        handleSelectConversation(conversation.id)
      }
      onKeyDown={(e) => {
        // Only treat Enter/Space as row activation when the ROW itself is
        // focused. Descendants (the rename input, the Options button) bubble
        // their keydowns here, and preventDefault() on a bubbled Space used to
        // swallow the space character in the rename input.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!isEditing && !showMenu && !showFolderPicker)
            handleSelectConversation(conversation.id);
        }
      }}
    >
      {isEditing ? (
        <input
          type="text"
          value={editingName}
          onChange={(e) => setEditingName(e.target.value)}
          onBlur={handleSaveName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              handleSaveName();
            } else if (e.key === 'Escape') {
              setEditingName(conversation.name || t('New Conversation'));
              setIsEditing(false);
            }
          }}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-gray-500 focus:outline-none dark:border-gray-600 dark:bg-surface-dark dark:text-gray-100"
        />
      ) : (
        <span className="flex flex-1 items-center gap-1.5 truncate text-sm text-gray-900 dark:text-gray-100">
          {conversation.conversationType &&
            WORKFLOW_META[conversation.conversationType] &&
            (() => {
              const WorkflowIcon =
                WORKFLOW_META[conversation.conversationType].icon;
              return (
                <WorkflowIcon
                  size={14}
                  aria-hidden
                  className="shrink-0 text-gray-500 dark:text-gray-400"
                />
              );
            })()}
          {/* title: the row truncates, so hovering reveals the full name */}
          <span
            className="truncate"
            title={conversation.name || t('New Conversation')}
          >
            {conversation.name || t('New Conversation')}
          </span>
        </span>
      )}
      <div
        className={`relative shrink-0 transition-opacity ${showMenu || showFolderPicker ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        {!isEditing && (
          <>
            <button
              ref={menuTriggerRef}
              className="rounded p-1 hover:bg-gray-200 dark:hover:bg-gray-700"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
              title={t('Options')}
              aria-label={t('Options')}
            >
              <IconDots
                size={14}
                className="text-gray-600 dark:text-gray-400"
              />
            </button>
          </>
        )}

        {/* Dropdown menu — portaled so it isn't trapped by the virtualized
            rows' transform stacking contexts or clipped by the list scroller */}
        <DropdownPortal
          triggerRef={menuTriggerRef}
          isOpen={showMenu}
          onClose={handleCloseMenu}
          align="right"
        >
          <div
            className="w-48 max-h-[60vh] overflow-y-auto rounded-md border border-gray-300 bg-white shadow-lg dark:border-gray-600 dark:bg-surface-dark"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-1">
              {/* Rename option */}
              <button
                className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800 rounded flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseMenu();
                  setIsEditing(true);
                  setEditingName(conversation.name || t('New Conversation'));
                }}
              >
                <IconEdit
                  size={14}
                  className="text-gray-600 dark:text-gray-400"
                />
                {t('Rename')}
              </button>

              {/* Move to folder — opens the searchable FolderPicker
                  anchored to the Options button (the menu closes first, so
                  the picker never fights the menu for the viewport) */}
              <button
                className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800 rounded flex items-center justify-between"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseMenu();
                  setShowFolderPicker(true);
                }}
              >
                <span className="flex items-center gap-2">
                  <IconFolder
                    size={14}
                    className="text-gray-600 dark:text-gray-400"
                  />
                  {t('Move to folder')}
                </span>
                <IconChevronRight
                  size={14}
                  className="text-gray-600 dark:text-gray-400"
                />
              </button>

              {/* Export option */}
              <button
                className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800 rounded flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseMenu();
                  handleExportConversation(conversation);
                }}
              >
                <IconDownload
                  size={14}
                  className="text-gray-600 dark:text-gray-400"
                />
                {t('Export')}
              </button>

              {/* Share option — only when the capability is wired */}
              {handleShareConversation && (
                <button
                  className="w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800 rounded flex items-center gap-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseMenu();
                    handleShareConversation(conversation);
                  }}
                >
                  <IconShare2
                    size={14}
                    className="text-gray-600 dark:text-gray-400"
                  />
                  {t('Share')}
                </button>
              )}

              {/* Delete option */}
              <button
                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-gray-100 dark:text-red-400 dark:hover:bg-gray-800 rounded flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseMenu();
                  handleDeleteConversation(conversation.id, e);
                }}
              >
                <IconTrash size={14} />
                {t('Delete')}
              </button>
            </div>
          </div>
        </DropdownPortal>

        <FolderPicker
          triggerRef={menuTriggerRef}
          isOpen={showFolderPicker}
          onClose={handleCloseFolderPicker}
          folders={folders}
          value={conversation.folderId ?? null}
          onSelect={(folderId) => handleMoveToFolder(conversation.id, folderId)}
          onCreateFolder={
            handleCreateFolderAndMove
              ? (name) => handleCreateFolderAndMove(conversation.id, name)
              : undefined
          }
        />
      </div>
    </div>
  );
}

export const ConversationItem = memo(ConversationItemInner);
