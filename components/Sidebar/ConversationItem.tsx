'use client';

import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconDownload,
  IconEdit,
  IconFolder,
  IconTrash,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { Conversation } from '@/types/chat';

interface ConversationItemProps {
  conversation: Conversation;
  selectedConversation: Conversation | null;
  handleSelectConversation: (id: string) => void;
  handleDeleteConversation: (id: string, e: React.MouseEvent) => void;
  handleMoveToFolder: (conversationId: string, folderId: string | null) => void;
  handleRenameConversation: (id: string, currentName: string) => void;
  handleExportConversation: (conversation: Conversation) => void;
  folders: any[];
  t: any;
}

export function ConversationItem({
  conversation,
  selectedConversation,
  handleSelectConversation,
  handleDeleteConversation,
  handleMoveToFolder,
  handleRenameConversation,
  handleExportConversation,
  folders,
  t,
}: ConversationItemProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [showFolderSubmenu, setShowFolderSubmenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingName, setEditingName] = useState(conversation.name);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
        setShowFolderSubmenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showMenu]);

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
      className={`group flex items-center gap-2 rounded p-2 cursor-pointer transition-all duration-200 ${
        selectedConversation?.id === conversation.id
          ? 'bg-neutral-200 dark:bg-neutral-700'
          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:shadow-sm'
      }`}
      onClick={() =>
        !isEditing && !showMenu && handleSelectConversation(conversation.id)
      }
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
              setEditingName(conversation.name);
              setIsEditing(false);
            }
          }}
          autoFocus
          onClick={(e) => e.stopPropagation()}
          className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-[#212121] dark:text-neutral-100"
        />
      ) : (
        <span className="flex-1 truncate text-sm text-neutral-900 dark:text-neutral-100">
          {conversation.name}
        </span>
      )}
      <div
        ref={menuRef}
        className={`relative shrink-0 transition-opacity ${showMenu ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      >
        {!isEditing && (
          <>
            <button
              className="rounded p-1 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(!showMenu);
              }}
              title={t('Options')}
            >
              <IconDots
                size={14}
                className="text-neutral-600 dark:text-neutral-400"
              />
            </button>
          </>
        )}

        {/* Dropdown menu */}
        {showMenu && (
          <div
            className="absolute right-0 top-full mt-1 z-10 w-48 rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-600 dark:bg-[#212121]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-1">
              {/* Rename option */}
              <button
                className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  setIsEditing(true);
                  setEditingName(conversation.name);
                }}
              >
                <IconEdit
                  size={14}
                  className="text-neutral-600 dark:text-neutral-400"
                />
                {t('Rename')}
              </button>

              {/* Move to folder option with submenu */}
              <div>
                <button
                  className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center justify-between"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowFolderSubmenu(!showFolderSubmenu);
                  }}
                >
                  <span className="flex items-center gap-2">
                    <IconFolder
                      size={14}
                      className="text-neutral-600 dark:text-neutral-400"
                    />
                    {t('Move to folder')}
                  </span>
                  {showFolderSubmenu ? (
                    <IconChevronDown
                      size={14}
                      className="text-neutral-600 dark:text-neutral-400"
                    />
                  ) : (
                    <IconChevronRight
                      size={14}
                      className="text-neutral-600 dark:text-neutral-400"
                    />
                  )}
                </button>

                {/* Folder submenu - inline expansion */}
                {showFolderSubmenu && (
                  <div className="pl-4 mt-1">
                    <button
                      className="w-full text-left px-3 py-2 text-xs text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center justify-between"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMoveToFolder(conversation.id, null);
                        setShowMenu(false);
                        setShowFolderSubmenu(false);
                      }}
                    >
                      {t('No folder')}
                      {!conversation.folderId && (
                        <IconCheck size={12} className="shrink-0" />
                      )}
                    </button>
                    {folders.map((folder) => (
                      <button
                        key={folder.id}
                        className="w-full text-left px-3 py-2 text-xs text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center justify-between"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMoveToFolder(conversation.id, folder.id);
                          setShowMenu(false);
                          setShowFolderSubmenu(false);
                        }}
                      >
                        <span className="truncate">{folder.name}</span>
                        {conversation.folderId === folder.id && (
                          <IconCheck size={12} className="shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Export option */}
              <button
                className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  handleExportConversation(conversation);
                }}
              >
                <IconDownload
                  size={14}
                  className="text-neutral-600 dark:text-neutral-400"
                />
                {t('Export')}
              </button>

              {/* Delete option */}
              <button
                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  handleDeleteConversation(conversation.id, e);
                }}
              >
                <IconTrash size={14} />
                {t('Delete')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
