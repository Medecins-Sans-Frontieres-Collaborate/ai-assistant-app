'use client';

import {
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconDots,
  IconDownload,
  IconEdit,
  IconFileText,
  IconFolder,
  IconFolderPlus,
  IconLogout,
  IconMessage,
  IconPlus,
  IconSearch,
  IconSettings,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { signOut, useSession } from 'next-auth/react';
import { useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { PiSidebarSimple } from 'react-icons/pi';

import { useTranslations } from 'next-intl';
import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useFolderManagement } from '@/client/hooks/ui/useFolderManagement';
import { useUI } from '@/client/hooks/ui/useUI';

import {
  exportConversation,
  readConversationFile,
  validateAndPrepareImport,
} from '@/lib/utils/app/export/conversationExport';
import {
  exportFolder,
  readFolderFile,
  validateAndPrepareFolderImport,
} from '@/lib/utils/app/export/folderExport';

import { Conversation } from '@/types/chat';
import { SearchMode } from '@/types/searchMode';

import { SearchModal } from './components/SearchModal';
import { SidebarHeader } from './components/SidebarHeader';
import { CustomizationsModal } from '@/components/QuickActions/CustomizationsModal';
import { DropdownPortal } from '@/components/UI/DropdownPortal';
import Modal from '@/components/UI/Modal';

import { ConversationItem } from './ConversationItem';
import { UserMenu } from './UserMenu';

import { v4 as uuidv4 } from 'uuid';

/**
 * Sidebar with conversation list - migrated to use Zustand stores
 */
export function Sidebar() {
  const t = useTranslations();
  const params = useParams();
  const locale = params?.locale || 'en';
  const { data: session } = useSession();
  const { showChatbar, toggleChatbar, setIsSettingsOpen, theme } = useUI();
  const {
    conversations,
    selectedConversation,
    selectConversation,
    addConversation,
    deleteConversation,
    updateConversation,
    searchTerm,
    setSearchTerm,
    filteredConversations,
    folders,
    addFolder,
    updateFolder,
    deleteFolder,
    isLoaded,
  } = useConversations();
  const {
    defaultModelId,
    models,
    temperature,
    systemPrompt,
    defaultSearchMode,
  } = useSettings();

  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isCustomizationsOpen, setIsCustomizationsOpen] = useState(false);
  const [userPhotoUrl, setUserPhotoUrl] = useState<string | null>(null);
  const [isLoadingPhoto, setIsLoadingPhoto] = useState(true);
  const [showNewChatMenu, setShowNewChatMenu] = useState(false);
  const [showNewFolderMenu, setShowNewFolderMenu] = useState(false);
  const [showFolderMenuId, setShowFolderMenuId] = useState<string | null>(null);

  // File input ref for importing conversations
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newChatButtonRef = useRef<HTMLDivElement>(null);
  const newFolderButtonRef = useRef<HTMLDivElement>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);

  // Determine which conversations to display (search results or all)
  const displayConversations = searchTerm
    ? filteredConversations
    : conversations;

  // Folder management
  const folderManager = useFolderManagement({
    items: displayConversations,
  });

  // Fetch user photo on mount (with localStorage caching)
  useEffect(() => {
    const fetchUserPhoto = async () => {
      if (!session?.user?.id) {
        setIsLoadingPhoto(false);
        return;
      }

      // Check if we have a cached photo for this user
      const cacheKey = `user_photo_${session.user.id}`;
      const cachedPhoto = localStorage.getItem(cacheKey);

      if (cachedPhoto) {
        setUserPhotoUrl(cachedPhoto);
        setIsLoadingPhoto(false);
        return;
      }

      setIsLoadingPhoto(true);
      try {
        const response = await fetch('/api/user/profile');
        if (response.ok) {
          const profile = await response.json();
          if (profile.photoUrl) {
            setUserPhotoUrl(profile.photoUrl);
            // Cache the photo URL in localStorage
            localStorage.setItem(cacheKey, profile.photoUrl);
          }
        }
      } catch (error) {
        console.error('Failed to fetch user photo:', error);
      } finally {
        setIsLoadingPhoto(false);
      }
    };

    fetchUserPhoto();
  }, [session?.user?.id]);

  // Keyboard shortcut for search (⌘K / Ctrl+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchModalOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close folder menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        folderMenuRef.current &&
        !folderMenuRef.current.contains(event.target as Node)
      ) {
        setShowFolderMenuId(null);
      }
    };

    if (showFolderMenuId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showFolderMenuId]);

  const handleNewConversation = () => {
    setShowNewChatMenu(false); // Close menu when creating new conversation

    // Check if the latest conversation is already empty
    const latestConversation = conversations[0];
    if (latestConversation && latestConversation.messages.length === 0) {
      if (latestConversation.id !== selectedConversation?.id) {
        // Switch to the existing empty conversation
        selectConversation(latestConversation.id);
      } else {
        // Already on the empty conversation - show toast
        toast(t('This conversation is already empty'));
      }
      return;
    }

    // Get the most recently selected model from the current conversation if available,
    // otherwise fall back to the default model from settings
    const currentModel = selectedConversation?.model;

    // Use current conversation's model directly if it exists (preserves custom agents),
    // otherwise look up the default model from settings
    const modelToUse = currentModel
      ? currentModel // Use current model directly (includes custom agents)
      : models.find((m) => m.id === defaultModelId);

    const defaultModel = modelToUse || models[0];
    if (!defaultModel) return;

    console.log(
      `[Sidebar] Creating new conversation with model: ${defaultModel.id} (${defaultModel.name})`,
      `\n  Source: ${currentModel ? 'current conversation' : 'default settings'}`,
      `\n  defaultModelId: ${defaultModelId}`,
    );

    // Use the model as-is (preserves all properties including custom agent fields)
    const modelWithDefaults = {
      ...defaultModel,
    };

    // Determine appropriate search mode based on model capabilities
    // If the model is an agent (has agentId), use the default search mode from settings
    // Otherwise, ensure we don't use AGENT mode on non-agent models
    let searchMode = defaultSearchMode;
    if (searchMode === SearchMode.AGENT && !defaultModel.agentId) {
      // Auto-fix: If default is AGENT but model doesn't support it, use INTELLIGENT instead
      searchMode = SearchMode.INTELLIGENT;
    }

    const newConversation: Conversation = {
      id: uuidv4(),
      name: t('New Conversation'),
      messages: [],
      model: modelWithDefaults,
      prompt: systemPrompt || '',
      temperature: temperature || 0.5,
      folderId: null,
      defaultSearchMode: searchMode, // Use model-appropriate search mode
    };

    addConversation(newConversation);
    selectConversation(newConversation.id);
  };

  const handleSelectConversation = (conversationId: string) => {
    selectConversation(conversationId);
  };

  const handleDeleteConversation = (
    conversationId: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    if (
      window.confirm(t('Are you sure you want to delete this conversation?'))
    ) {
      deleteConversation(conversationId);
    }
  };

  const handleCreateFolder = () => {
    folderManager.handleCreateFolder('chat', t('New folder'), addFolder);
  };

  const handleCreatePromptFolder = () => {
    folderManager.handleCreateFolder('prompt', t('New folder'), addFolder);
  };

  const handleMoveToFolder = (
    conversationId: string,
    folderId: string | null,
  ) => {
    updateConversation(conversationId, { folderId });
  };

  const handleRenameConversation = (
    conversationId: string,
    newName: string,
  ) => {
    updateConversation(conversationId, { name: newName });
  };

  const handleExportConversation = (conversation: Conversation) => {
    try {
      exportConversation(conversation);
      toast.success(t('Conversation exported successfully'));
    } catch (error) {
      console.error('Error exporting conversation:', error);
      toast.error(t('Failed to export conversation'));
    }
  };

  const handleExportFolder = (folderId: string, folderName: string) => {
    try {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) {
        toast.error(t('Folder not found'));
        return;
      }

      exportFolder(folder, conversations);
      const folderConversations = conversations.filter(
        (c) => c.folderId === folderId,
      );
      toast.success(
        t('Folder exported with {count} conversations', {
          count: folderConversations.length,
        }),
      );
    } catch (error) {
      console.error('Error exporting folder:', error);
      toast.error(t('Failed to export folder'));
    }
  };

  const handleImportClick = () => {
    setShowNewChatMenu(false); // Close menu when opening file picker
    setShowNewFolderMenu(false); // Close folder menu when opening file picker
    fileInputRef.current?.click();
  };

  const handleImportConversation = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      // Read the file content
      const fileContent = await file.text();
      const data = JSON.parse(fileContent);

      // Determine the type of import based on the data structure
      if (data.type === 'folder-with-conversations') {
        // Handle folder import
        const result = validateAndPrepareFolderImport(
          data,
          folders,
          conversations,
        );

        if (!result.isValid || !result.folder || !result.conversations) {
          toast.error(result.error || t('Invalid folder file'));
          return;
        }

        // Add the folder first
        addFolder(result.folder);

        // Then add all conversations
        result.conversations.forEach((conv) => {
          addConversation(conv);
        });

        toast.success(
          t('Folder imported with {count} conversations', {
            count: result.conversations.length,
          }),
        );
      } else if (data.type === 'single-conversation') {
        // Handle single conversation import
        const result = validateAndPrepareImport(data, conversations);

        if (!result.isValid || !result.conversation) {
          toast.error(result.error || t('Invalid conversation file'));
          return;
        }

        // Add the conversation to the store
        addConversation(result.conversation);
        toast.success(t('Conversation imported successfully'));
      } else {
        toast.error(t('Unrecognized file format'));
      }
    } catch (error) {
      console.error('Error importing:', error);
      toast.error(t('Failed to import file'));
    } finally {
      // Reset the file input so the same file can be imported again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Group conversations by folder using the hook's grouped items
  const conversationsByFolder = folderManager.groupedItems.byFolder;
  const conversationsWithoutFolder = folderManager.groupedItems.unfolderedItems;

  const folderGroups = folders.map((folder) => ({
    folder,
    conversations: conversationsByFolder[folder.id] || [],
  }));

  return (
    <>
      {/* Mobile backdrop */}
      {showChatbar && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40 transition-opacity"
          onClick={toggleChatbar}
        />
      )}

      {/* Sidebar - hidden on mobile by default, overlay when open */}
      <div
        className={`fixed left-0 top-0 z-50 h-full flex flex-col border-r border-neutral-300 bg-white dark:border-neutral-700 dark:bg-[#171717] transition-all duration-300 ease-in-out w-[260px] ${
          showChatbar
            ? 'translate-x-0 overflow-hidden'
            : '-translate-x-full md:translate-x-0 md:w-14 overflow-visible'
        }`}
      >
        <SidebarHeader
          showChatbar={showChatbar}
          toggleChatbar={toggleChatbar}
          theme={theme}
          t={t}
        />

        {/* Action buttons */}
        <div
          className={`border-b transition-all duration-300 ${showChatbar ? 'py-2 px-3 space-y-1 border-neutral-300 dark:border-neutral-700 overflow-hidden' : 'py-3 px-0 space-y-2 border-transparent overflow-visible'}`}
        >
          {/* New chat with dropdown menu */}
          <div ref={newChatButtonRef} className="relative">
            <div
              className={`group flex items-center w-full rounded-lg text-sm font-medium text-neutral-900 hover:bg-neutral-100 dark:text-white dark:hover:bg-neutral-800 transition-all duration-300 ${showChatbar ? 'gap-2 px-3 py-2' : 'justify-center px-2 py-3'}`}
            >
              <button
                className={`flex items-center ${showChatbar ? 'gap-2 flex-1' : ''}`}
                onClick={handleNewConversation}
                title={t('New chat')}
              >
                <IconPlus size={20} stroke={2} className="shrink-0" />
                <span
                  className={`whitespace-nowrap transition-all duration-300 ${showChatbar ? 'opacity-100 w-auto' : 'opacity-0 w-0 overflow-hidden'}`}
                >
                  {t('New chat')}
                </span>
              </button>
              {showChatbar && (
                <button
                  className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowNewChatMenu(!showNewChatMenu);
                  }}
                  title={t('Options')}
                >
                  <IconDots size={16} className="shrink-0" />
                </button>
              )}
              {!showChatbar && (
                <span className="absolute left-full ml-2 px-2 py-1 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity shadow-lg">
                  {t('New chat')}
                </span>
              )}
            </div>
          </div>

          {/* Dropdown menu via Portal */}
          <DropdownPortal
            triggerRef={newChatButtonRef}
            isOpen={showNewChatMenu && showChatbar}
            onClose={() => setShowNewChatMenu(false)}
          >
            <div className="rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-600 dark:bg-[#212121]">
              <div className="p-1">
                <button
                  className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                  onClick={handleImportClick}
                >
                  <IconUpload size={14} />
                  {t('Import conversation')}
                </button>
              </div>
            </div>
          </DropdownPortal>

          {/* Search button - visible in both states */}
          <button
            className={`group relative flex items-center w-full rounded-lg text-sm text-neutral-900 hover:bg-neutral-100 dark:text-white dark:hover:bg-neutral-800 transition-all duration-300 ${showChatbar ? 'gap-2 px-3 py-2' : 'justify-center px-2 py-3'}`}
            onClick={() => setIsSearchModalOpen(true)}
            title={t('Search chats')}
          >
            <IconSearch size={showChatbar ? 16 : 20} className="shrink-0" />
            <span
              className={`whitespace-nowrap transition-all duration-300 ${showChatbar ? 'opacity-100 w-auto' : 'opacity-0 w-0 overflow-hidden'}`}
            >
              {t('Search chats')}
            </span>
            {showChatbar && (
              <span className="ml-auto text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
                ⌘K
              </span>
            )}
            {!showChatbar && (
              <span className="absolute left-full ml-2 px-2 py-1 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity shadow-lg">
                {t('Search chats')}
              </span>
            )}
          </button>

          {/* Quick Actions button - visible in both states */}
          <button
            className={`group relative flex items-center w-full rounded-lg text-sm text-neutral-900 hover:bg-neutral-100 dark:text-white dark:hover:bg-neutral-800 transition-all duration-300 ${showChatbar ? 'gap-2 px-3 py-2' : 'justify-center px-2 py-3'}`}
            onClick={() => setIsCustomizationsOpen(true)}
            title={t('sidebar.quickActionsTitle')}
          >
            <IconBolt size={showChatbar ? 16 : 20} className="shrink-0" />
            <span
              className={`whitespace-nowrap transition-all duration-300 ${showChatbar ? 'opacity-100 w-auto' : 'opacity-0 w-0 overflow-hidden'}`}
            >
              {t('sidebar.quickActions')}
            </span>
            {!showChatbar && (
              <span className="absolute left-full ml-2 px-2 py-1 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-[100] transition-opacity shadow-lg">
                {t('sidebar.quickActions')}
              </span>
            )}
          </button>

          {/* New folder button with dropdown menu - only in expanded state */}
          <div
            className={`transition-all duration-300 ${showChatbar ? 'opacity-100 max-h-[100px]' : 'opacity-0 max-h-0 overflow-hidden'}`}
          >
            <div ref={newFolderButtonRef} className="relative">
              <div className="flex items-center gap-2 w-full rounded-lg px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-white dark:hover:bg-neutral-800">
                <button
                  className="flex items-center gap-2 flex-1"
                  onClick={handleCreateFolder}
                  title={t('New folder')}
                >
                  <IconFolderPlus size={16} />
                  <span className="whitespace-nowrap">{t('New folder')}</span>
                </button>
                <button
                  className="p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowNewFolderMenu(!showNewFolderMenu);
                  }}
                  title={t('Options')}
                >
                  <IconDots size={16} className="shrink-0" />
                </button>
              </div>
            </div>
          </div>

          {/* New folder dropdown menu via Portal */}
          <DropdownPortal
            triggerRef={newFolderButtonRef}
            isOpen={showNewFolderMenu && showChatbar}
            onClose={() => setShowNewFolderMenu(false)}
          >
            <div className="rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-600 dark:bg-[#212121]">
              <div className="p-1">
                <button
                  className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                  onClick={handleImportClick}
                >
                  <IconUpload size={14} />
                  {t('Import folder')}
                </button>
              </div>
            </div>
          </DropdownPortal>
        </div>

        {/* Content */}
        <div
          className={`flex-1 overflow-y-auto transition-all duration-300 ${showChatbar ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        >
          {displayConversations.length === 0 ? (
            <div className="p-4 text-center text-sm text-neutral-500">
              {searchTerm
                ? t('No conversations found')
                : isLoaded
                  ? t('No conversations yet')
                  : null}
            </div>
          ) : (
            <div className="space-y-1 p-2">
              {/* Render folders */}
              {folderGroups.map(
                ({ folder, conversations: folderConversations }) => (
                  <div
                    key={folder.id}
                    className="mb-2"
                    onDrop={(e) =>
                      folderManager.handleDrop(
                        e,
                        folder.id,
                        handleMoveToFolder,
                        'conversationId',
                      )
                    }
                    onDragOver={(e) =>
                      folderManager.handleDragOver(e, folder.id)
                    }
                    onDragLeave={folderManager.handleDragLeave}
                  >
                    {/* Folder header */}
                    <div
                      className={`group flex items-center gap-2 rounded p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                        folderManager.dragOverFolderId === folder.id
                          ? 'bg-blue-100 dark:bg-blue-900/30 ring-2 ring-blue-400'
                          : ''
                      }`}
                    >
                      <button
                        onClick={() => folderManager.toggleFolder(folder.id)}
                        className="shrink-0"
                      >
                        {folderManager.collapsedFolders.has(folder.id) ? (
                          <IconChevronRight
                            size={16}
                            className="text-neutral-600 dark:text-neutral-400"
                          />
                        ) : (
                          <IconChevronDown
                            size={16}
                            className="text-neutral-600 dark:text-neutral-400"
                          />
                        )}
                      </button>
                      <IconFolder
                        size={16}
                        className="shrink-0 text-neutral-600 dark:text-neutral-400"
                      />
                      {folderManager.editingFolderId === folder.id &&
                      !isCustomizationsOpen ? (
                        <input
                          ref={folderManager.editInputRef}
                          type="text"
                          value={folderManager.editingFolderName}
                          onChange={(e) =>
                            folderManager.setEditingFolderName(e.target.value)
                          }
                          onBlur={() =>
                            folderManager.handleSaveFolderName(updateFolder)
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              folderManager.handleSaveFolderName(updateFolder);
                            } else if (e.key === 'Escape') {
                              folderManager.setEditingFolderId(null);
                              folderManager.setEditingFolderName('');
                            }
                          }}
                          autoFocus
                          className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-600 dark:bg-[#212121] dark:text-neutral-100"
                        />
                      ) : (
                        <span className="flex-1 truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
                          {folder.name} ({folderConversations.length})
                        </span>
                      )}
                      <div
                        ref={
                          showFolderMenuId === folder.id
                            ? folderMenuRef
                            : undefined
                        }
                        className={`relative shrink-0 transition-opacity ${showFolderMenuId === folder.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                      >
                        {folderManager.editingFolderId !== folder.id && (
                          <>
                            <button
                              className="rounded p-1 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowFolderMenuId(
                                  showFolderMenuId === folder.id
                                    ? null
                                    : folder.id,
                                );
                              }}
                              title={t('Options')}
                            >
                              <IconDots
                                size={14}
                                className="text-neutral-600 dark:text-neutral-400"
                              />
                            </button>

                            {/* Dropdown menu */}
                            {showFolderMenuId === folder.id && (
                              <div
                                className="absolute right-0 top-full mt-1 z-50 w-48 rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-600 dark:bg-[#212121]"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div className="p-1">
                                  {/* Rename option */}
                                  <button
                                    className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setShowFolderMenuId(null);
                                      folderManager.handleRenameFolder(
                                        folder.id,
                                        folder.name,
                                      );
                                    }}
                                  >
                                    <IconEdit
                                      size={14}
                                      className="text-neutral-600 dark:text-neutral-400"
                                    />
                                    {t('Rename')}
                                  </button>

                                  {/* Export option */}
                                  <button
                                    className="w-full text-left px-3 py-2 text-sm text-neutral-900 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setShowFolderMenuId(null);
                                      handleExportFolder(
                                        folder.id,
                                        folder.name,
                                      );
                                    }}
                                  >
                                    <IconDownload
                                      size={14}
                                      className="text-neutral-600 dark:text-neutral-400"
                                    />
                                    {t('Export folder')}
                                  </button>

                                  {/* Delete option */}
                                  <button
                                    className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-neutral-100 dark:text-red-400 dark:hover:bg-neutral-800 rounded flex items-center gap-2"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setShowFolderMenuId(null);
                                      folderManager.handleDeleteFolder(
                                        folder.id,
                                        e,
                                        deleteFolder,
                                        t(
                                          'Are you sure you want to delete this folder?',
                                        ),
                                      );
                                    }}
                                  >
                                    <IconTrash size={14} />
                                    {t('Delete')}
                                  </button>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Folder conversations */}
                    {!folderManager.collapsedFolders.has(folder.id) && (
                      <div className="ml-6 space-y-1 mt-1">
                        {folderConversations.map((conversation) => (
                          <ConversationItem
                            key={conversation.id}
                            conversation={conversation}
                            selectedConversation={selectedConversation}
                            handleSelectConversation={handleSelectConversation}
                            handleDeleteConversation={handleDeleteConversation}
                            handleMoveToFolder={handleMoveToFolder}
                            handleRenameConversation={handleRenameConversation}
                            handleExportConversation={handleExportConversation}
                            folders={folders}
                            t={t}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ),
              )}

              {/* Conversations without folder */}
              {conversationsWithoutFolder.length > 0 && (
                <div
                  onDrop={(e) =>
                    folderManager.handleDrop(
                      e,
                      null,
                      handleMoveToFolder,
                      'conversationId',
                    )
                  }
                  onDragOver={(e) => folderManager.handleDragOver(e, null)}
                  onDragLeave={folderManager.handleDragLeave}
                >
                  {conversationsWithoutFolder.map((conversation) => (
                    <ConversationItem
                      key={conversation.id}
                      conversation={conversation}
                      selectedConversation={selectedConversation}
                      handleSelectConversation={handleSelectConversation}
                      handleDeleteConversation={handleDeleteConversation}
                      handleMoveToFolder={handleMoveToFolder}
                      handleRenameConversation={handleRenameConversation}
                      handleExportConversation={handleExportConversation}
                      folders={folders}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer with user menu */}
        <UserMenu
          showChatbar={showChatbar}
          onSettingsClick={() => setIsSettingsOpen(true)}
          t={t}
          userPhotoUrl={userPhotoUrl}
          isLoadingPhoto={isLoadingPhoto}
        />

        <SearchModal
          isOpen={isSearchModalOpen}
          onClose={() => setIsSearchModalOpen(false)}
          searchTerm={searchTerm}
          setSearchTerm={setSearchTerm}
          filteredConversations={filteredConversations}
          selectConversation={selectConversation}
          t={t}
        />
      </div>

      {/* Customizations Modal */}
      <CustomizationsModal
        isOpen={isCustomizationsOpen}
        onClose={() => setIsCustomizationsOpen(false)}
      />

      {/* Hidden file input for importing conversations */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImportConversation}
        style={{ display: 'none' }}
      />
    </>
  );
}
