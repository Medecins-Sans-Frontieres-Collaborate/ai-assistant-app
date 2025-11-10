'use client';

import {
  IconBolt,
  IconBraces,
  IconChevronDown,
  IconChevronRight,
  IconFileExport,
  IconFolder,
  IconFolderPlus,
  IconPlus,
  IconRepeat,
  IconSearch,
  IconSparkles,
  IconUpload,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useFolderManagement } from '@/client/hooks/ui/useFolderManagement';
import { useItemSearch } from '@/client/hooks/ui/useItemSearch';
import { useModalForm } from '@/client/hooks/ui/useModalForm';

import {
  exportPrompts,
  handlePromptFileImport,
  importPrompts,
} from '@/lib/utils/app/export/promptExport';

import { FolderInterface } from '@/types/folder';
import { Prompt } from '@/types/prompt';

import { PromptDashboard } from '../Prompts/PromptDashboard';
import { PromptItem } from '../Prompts/PromptItem';

import { v4 as uuidv4 } from 'uuid';

interface PromptsTabProps {
  prompts: Prompt[];
  folders: FolderInterface[];
  onClose: () => void;
}

export function PromptsTab({ prompts, folders, onClose }: PromptsTabProps) {
  const t = useTranslations();

  // Hooks
  const { addPrompt, updatePrompt, deletePrompt, defaultModelId, models } =
    useSettings();
  const { addFolder, updateFolder, deleteFolder } = useConversations();

  // PromptDashboard modal state
  const promptModal = useModalForm<{
    name: string;
    description: string;
    content: string;
    toneId: string | null;
    tags: string[];
  }>({
    initialState: {
      name: '',
      description: '',
      content: '',
      toneId: null,
      tags: [],
    },
  });

  // Local state
  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Search
  const {
    searchQuery,
    setSearchQuery,
    filteredItems: filteredPrompts,
  } = useItemSearch({
    items: prompts,
    searchFields: ['name'],
  });

  // Find selected prompt
  const selectedPrompt = prompts.find((p) => p.id === selectedPromptId);

  // Folder management
  const folderManager = useFolderManagement({
    items: filteredPrompts,
  });

  const promptsByFolder = folderManager.groupedItems.byFolder;
  const unfolderPrompts = folderManager.groupedItems.unfolderedItems;

  const handleMoveToFolder = (promptId: string, folderId: string | null) => {
    updatePrompt(promptId, { folderId });
  };

  const handleDeletePrompt = (promptId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(t('Are you sure you want to delete this prompt?'))) {
      deletePrompt(promptId);
      if (selectedPromptId === promptId) {
        setSelectedPromptId(null);
      }
    }
  };

  const handleExportAll = () => {
    if (prompts.length === 0) {
      alert(t('No prompts to export'));
      return;
    }
    exportPrompts(prompts);
  };

  const handleExportSingle = (prompt: Prompt) => {
    exportPrompts([prompt]);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const data = await handlePromptFileImport(file);
      const { prompts: newPrompts, conflicts } = importPrompts(data, prompts);

      if (conflicts.length > 0) {
        const conflictNames = conflicts.map((c) => c.imported.name).join(', ');
        const proceed = confirm(
          t('prompts_conflict_message', {
            count: conflicts.length,
            names: conflictNames,
          }),
        );
        if (!proceed) {
          e.target.value = '';
          return;
        }
      }

      newPrompts.forEach((prompt) => addPrompt(prompt));
      alert(
        t('prompts_import_success', {
          count: newPrompts.length,
        }),
      );
    } catch (error) {
      alert(
        t('import_error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
    }

    e.target.value = '';
  };

  // Render empty state or main content
  const renderContent = () => {
    // Show full-width empty state when there are no prompts
    if (filteredPrompts.length === 0 && !searchQuery) {
      return (
        <div className="flex h-full items-center justify-center p-8">
          <div className="max-w-3xl mx-auto space-y-8">
            {/* Header */}
            <div className="text-center space-y-2">
              <h3 className="text-2xl font-semibold text-gray-900 dark:text-white">
                {t('Save Time with Reusable Prompts')}
              </h3>
              <p className="text-gray-600 dark:text-gray-400">
                {t('Turn your repetitive tasks into one-click commands')}
              </p>
            </div>

            {/* Example */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
              <div className="flex items-center gap-2 mb-4">
                <IconSparkles
                  size={18}
                  className="text-gray-600 dark:text-gray-400"
                />
                <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                  {t('Example Prompt')}
                </h4>
              </div>

              <div className="space-y-4">
                {/* Prompt definition */}
                <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
                  <div className="bg-neutral-100 dark:bg-neutral-800 px-4 py-2 border-b border-neutral-200 dark:border-neutral-700">
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {t('Email Response Template')}
                    </p>
                  </div>
                  <div className="p-4 bg-white dark:bg-neutral-900">
                    <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-mono">
                      {`Write an email response to {{recipient}} regarding {{topic}}.

Include:
- Response to their inquiry
- Clear next steps
- Action items or deadlines if applicable`}
                    </pre>
                  </div>
                </div>

                {/* How to use */}
                <div className="flex items-start gap-3 p-3 rounded-lg bg-neutral-50 dark:bg-neutral-800/50">
                  <div className="shrink-0 w-6 h-6 flex items-center justify-center rounded bg-neutral-200 dark:bg-neutral-700 mt-0.5">
                    <span className="text-xs font-semibold text-neutral-600 dark:text-neutral-400">
                      /
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {t(
                        'Type / in chat, select your prompt, and fill in the variables when prompted',
                      )}
                    </p>
                  </div>
                </div>

                {/* CTA Button */}
                <div className="flex justify-center pt-4">
                  <button
                    onClick={() => promptModal.openNew()}
                    className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-lg"
                  >
                    <IconSparkles size={18} />
                    {t('Create Your First Prompt')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Main content with list and detail panels
    return (
      <div className="flex flex-col md:flex-row h-full">
        {/* Left Panel - List */}
        <div className="w-full md:w-1/2 border-r-0 md:border-r border-b md:border-b-0 border-gray-200 dark:border-gray-700 flex flex-col max-h-[50%] md:max-h-full">
          {/* Toolbar */}
          <div className="flex-shrink-0 px-4 py-3 bg-gray-50 dark:bg-[#1a1a1a] border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between gap-3">
              {/* Search */}
              <div className="flex-1 relative max-w-md">
                <IconSearch
                  size={16}
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('searchPromptsPlaceholder')}
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <button
                  onClick={handleImportClick}
                  className="p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg"
                  title={t('Import')}
                >
                  <IconUpload size={18} />
                </button>
                <button
                  onClick={handleExportAll}
                  className="p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg"
                  title={t('Export all')}
                >
                  <IconFileExport size={18} />
                </button>
                <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
                <button
                  onClick={() =>
                    folderManager.handleCreateFolder(
                      'prompt',
                      t('New folder'),
                      addFolder,
                    )
                  }
                  className="p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg"
                  title={t('New folder')}
                >
                  <IconFolderPlus size={18} />
                </button>
                <button
                  onClick={() => promptModal.openNew()}
                  className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
                >
                  <IconPlus size={16} />
                  {t('New')}
                </button>
              </div>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto p-4">
            {/* Folders */}
            {folders.map((folder) => {
              const folderPrompts = promptsByFolder[folder.id] || [];
              if (folderPrompts.length === 0 && !folderManager.editingFolderId)
                return null;

              const isCollapsed = folderManager.collapsedFolders.has(folder.id);

              return (
                <div key={folder.id} className="mb-4">
                  <div
                    className={`flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                      folderManager.dragOverFolderId === folder.id
                        ? 'bg-blue-100 dark:bg-blue-900/30'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                    onClick={() => folderManager.toggleFolder(folder.id)}
                    onDrop={(e) =>
                      folderManager.handleDrop(
                        e,
                        folder.id,
                        handleMoveToFolder,
                        'promptId',
                      )
                    }
                    onDragOver={(e) =>
                      folderManager.handleDragOver(e, folder.id)
                    }
                    onDragLeave={folderManager.handleDragLeave}
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {isCollapsed ? (
                        <IconChevronRight size={16} className="text-gray-500" />
                      ) : (
                        <IconChevronDown size={16} className="text-gray-500" />
                      )}
                      <IconFolder size={16} className="text-gray-500" />
                      {folderManager.editingFolderId === folder.id ? (
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
                            if (e.key === 'Enter')
                              folderManager.handleSaveFolderName(updateFolder);
                            if (e.key === 'Escape') {
                              folderManager.setEditingFolderId(null);
                              folderManager.setEditingFolderName('');
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 px-2 py-0.5 text-sm bg-white dark:bg-gray-800 border border-blue-500 rounded"
                        />
                      ) : (
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                          {folder.name}
                        </span>
                      )}
                      <span className="text-xs text-gray-500">
                        {folderPrompts.length}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        folderManager.handleRenameFolder(
                          folder.id,
                          folder.name,
                        );
                      }}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                    >
                      ...
                    </button>
                  </div>

                  {!isCollapsed && folderPrompts.length > 0 && (
                    <div className="ml-4 mt-1 space-y-1">
                      {folderPrompts.map((prompt) => (
                        <div
                          key={prompt.id}
                          draggable
                          onDragStart={(e) =>
                            folderManager.handleDragStart(
                              e,
                              prompt.id,
                              'promptId',
                            )
                          }
                          onDragEnd={() => folderManager.setIsDragging(false)}
                        >
                          <PromptItem
                            prompt={prompt}
                            folders={folders}
                            isSelected={selectedPromptId === prompt.id}
                            onClick={() => setSelectedPromptId(prompt.id)}
                            onEdit={() => {
                              promptModal.openEdit(prompt.id, {
                                name: prompt.name,
                                description: prompt.description || '',
                                content: prompt.content,
                                toneId: prompt.toneId || null,
                                tags: prompt.tags || [],
                              });
                            }}
                            onDelete={(e) => handleDeletePrompt(prompt.id, e)}
                            onMoveToFolder={handleMoveToFolder}
                            onExport={() => handleExportSingle(prompt)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Unfolder prompts */}
            {unfolderPrompts.length > 0 && (
              <div
                className={`space-y-1 ${folderManager.dragOverFolderId === null && folderManager.isDragging ? 'bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2' : ''}`}
                onDrop={(e) =>
                  folderManager.handleDrop(
                    e,
                    null,
                    handleMoveToFolder,
                    'promptId',
                  )
                }
                onDragOver={(e) => folderManager.handleDragOver(e, null)}
                onDragLeave={folderManager.handleDragLeave}
              >
                {unfolderPrompts.map((prompt) => (
                  <div
                    key={prompt.id}
                    draggable
                    onDragStart={(e) =>
                      folderManager.handleDragStart(e, prompt.id, 'promptId')
                    }
                    onDragEnd={() => folderManager.setIsDragging(false)}
                  >
                    <PromptItem
                      prompt={prompt}
                      folders={folders}
                      isSelected={selectedPromptId === prompt.id}
                      onClick={() => setSelectedPromptId(prompt.id)}
                      onEdit={() => {
                        promptModal.openEdit(prompt.id, {
                          name: prompt.name,
                          description: prompt.description || '',
                          content: prompt.content,
                          toneId: prompt.toneId || null,
                          tags: prompt.tags || [],
                        });
                      }}
                      onDelete={(e) => handleDeletePrompt(prompt.id, e)}
                      onMoveToFolder={handleMoveToFolder}
                      onExport={() => handleExportSingle(prompt)}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* No search results */}
            {filteredPrompts.length === 0 && searchQuery && (
              <div className="text-center py-12 text-neutral-500 dark:text-neutral-400">
                {t('No prompts found')}
              </div>
            )}
          </div>
        </div>

        {/* Right Panel - Detail */}
        <div className="w-full md:w-1/2 flex flex-col min-h-0">
          {selectedPrompt ? (
            <div className="flex-1 overflow-y-auto p-6">
              <h2 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">
                {selectedPrompt.name}
              </h2>
              {selectedPrompt.description && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
                  {selectedPrompt.description}
                </p>
              )}

              <div>
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
                  {t('Content')}
                </h3>
                <div className="p-4 bg-gray-50 dark:bg-[#2a2a2a] rounded-lg border border-gray-200 dark:border-gray-700">
                  <pre className="text-sm text-gray-900 dark:text-gray-100 whitespace-pre-wrap font-mono">
                    {selectedPrompt.content}
                  </pre>
                </div>
              </div>

              <div className="flex gap-2 mt-6">
                <button
                  onClick={() => {
                    promptModal.openEdit(selectedPrompt.id, {
                      name: selectedPrompt.name,
                      description: selectedPrompt.description || '',
                      content: selectedPrompt.content,
                      toneId: selectedPrompt.toneId || null,
                      tags: selectedPrompt.tags || [],
                    });
                  }}
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                >
                  {t('Edit')}
                </button>
                <button
                  onClick={(e) => handleDeletePrompt(selectedPrompt.id, e)}
                  className="px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
                >
                  {t('Delete')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 dark:text-gray-600">
              <div className="text-center">
                <IconSearch size={48} className="mx-auto mb-3 opacity-50" />
                <p>{t('Select a prompt to view details')}</p>
              </div>
            </div>
          )}
        </div>

        {/* Prompt Editor Modal */}
        <PromptDashboard
          isOpen={promptModal.isOpen}
          onClose={() => promptModal.close()}
          onSave={(
            name: string,
            description: string,
            content: string,
            toneId?: string | null,
            tags?: string[],
          ) => {
            if (promptModal.itemId) {
              // Update existing prompt
              updatePrompt(promptModal.itemId, {
                name,
                description,
                content,
                toneId,
                tags,
              });
            } else {
              // Create new prompt
              const defaultModel =
                models.find((m) => m.id === defaultModelId) || models[0];
              const newPrompt: Prompt = {
                id: uuidv4(),
                name,
                description,
                content,
                model: defaultModel,
                folderId: null,
                toneId,
                tags,
              };
              addPrompt(newPrompt);
            }
            promptModal.close();
          }}
          initialName={promptModal.formData.name}
          initialDescription={promptModal.formData.description}
          initialContent={promptModal.formData.content}
          initialToneId={promptModal.formData.toneId}
          initialTags={promptModal.formData.tags}
        />
      </div>
    );
  };

  return (
    <>
      {renderContent()}

      {/* Prompt Editor Modal - Always rendered */}
      <PromptDashboard
        isOpen={promptModal.isOpen}
        onClose={() => promptModal.close()}
        onSave={(
          name: string,
          description: string,
          content: string,
          toneId?: string | null,
          tags?: string[],
        ) => {
          if (promptModal.itemId) {
            // Update existing prompt
            updatePrompt(promptModal.itemId, {
              name,
              description,
              content,
              toneId,
              tags,
            });
          } else {
            // Create new prompt
            const defaultModel =
              models.find((m) => m.id === defaultModelId) || models[0];
            const newPrompt: Prompt = {
              id: uuidv4(),
              name,
              description,
              content,
              model: defaultModel,
              folderId: null,
              toneId,
              tags,
            };
            addPrompt(newPrompt);
          }
          promptModal.close();
        }}
        initialName={promptModal.formData.name}
        initialDescription={promptModal.formData.description}
        initialContent={promptModal.formData.content}
        initialToneId={promptModal.formData.toneId}
        initialTags={promptModal.formData.tags}
      />
    </>
  );
}
