'use client';

import {
  IconDownload,
  IconFileExport,
  IconInfoCircle,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconVolume,
  IconX,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useTones } from '@/client/hooks/settings/useTones';

import {
  TeamTemplateExportOptions,
  exportTeamTemplate,
  getImportedTemplates,
  getTemplateItemIds,
  handleTeamTemplateFileImport,
  importTeamTemplate,
} from '@/lib/utils/app/export/teamTemplateExport';

interface TeamTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TeamTemplateModal({ isOpen, onClose }: TeamTemplateModalProps) {
  const t = useTranslations();

  const {
    prompts,
    addPrompt,
    deletePrompt,
    customAgents,
    addCustomAgent,
    deleteCustomAgent,
  } = useSettings();
  const { tones, addTone, deleteTone } = useTones();
  const { folders, addFolder, deleteFolder } = useConversations();

  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [includePrompts, setIncludePrompts] = useState(true);
  const [includeTones, setIncludeTones] = useState(true);
  const [includeFolders, setIncludeFolders] = useState(true);
  const [includeCustomAgents, setIncludeCustomAgents] = useState(false);

  const [selectedPromptIds, setSelectedPromptIds] = useState<string[]>([]);
  const [selectedToneIds, setSelectedToneIds] = useState<string[]>([]);
  const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>([]);
  const [selectedCustomAgentIds, setSelectedCustomAgentIds] = useState<
    string[]
  >([]);

  const [showPromptSelection, setShowPromptSelection] = useState(false);
  const [showToneSelection, setShowToneSelection] = useState(false);
  const [showFolderSelection, setShowFolderSelection] = useState(false);
  const [showCustomAgentSelection, setShowCustomAgentSelection] =
    useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExportTemplate = () => {
    if (!templateName.trim()) {
      alert(t('Please enter a template name'));
      return;
    }

    if (
      !includePrompts &&
      !includeTones &&
      !includeFolders &&
      !includeCustomAgents
    ) {
      alert(t('Please select at least one item type to export'));
      return;
    }

    const options: TeamTemplateExportOptions = {
      name: templateName.trim(),
      description: templateDescription.trim() || undefined,
      includePrompts,
      includeTones,
      includeFolders,
      includeCustomAgents,
      selectedPromptIds:
        showPromptSelection && selectedPromptIds.length > 0
          ? selectedPromptIds
          : undefined,
      selectedToneIds:
        showToneSelection && selectedToneIds.length > 0
          ? selectedToneIds
          : undefined,
      selectedFolderIds:
        showFolderSelection && selectedFolderIds.length > 0
          ? selectedFolderIds
          : undefined,
      selectedCustomAgentIds:
        showCustomAgentSelection && selectedCustomAgentIds.length > 0
          ? selectedCustomAgentIds
          : undefined,
    };

    exportTeamTemplate(options, prompts, tones, folders, customAgents);

    alert(t('Team template exported successfully'));
    setTemplateName('');
    setTemplateDescription('');
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const data = await handleTeamTemplateFileImport(file);
      const result = importTeamTemplate(
        data,
        prompts,
        tones,
        folders,
        customAgents,
      );

      // Show conflicts if any
      const conflictCount =
        result.conflicts.prompts.length +
        result.conflicts.tones.length +
        result.conflicts.folders.length;

      if (conflictCount > 0) {
        const conflictMessages: string[] = [];
        if (result.conflicts.prompts.length > 0) {
          conflictMessages.push(
            t('team_template_conflict_prompts', {
              count: result.conflicts.prompts.length,
              names: result.conflicts.prompts
                .map((c) => c.imported.name)
                .join(', '),
            }),
          );
        }
        if (result.conflicts.tones.length > 0) {
          conflictMessages.push(
            t('team_template_conflict_tones', {
              count: result.conflicts.tones.length,
              names: result.conflicts.tones
                .map((c) => c.imported.name)
                .join(', '),
            }),
          );
        }
        if (result.conflicts.folders.length > 0) {
          conflictMessages.push(
            t('team_template_conflict_folders', {
              count: result.conflicts.folders.length,
              names: result.conflicts.folders
                .map((c) => c.imported.name)
                .join(', '),
            }),
          );
        }

        const proceed = confirm(
          t('team_template_conflict_message', {
            count: conflictCount,
            details: conflictMessages.join('\n'),
          }),
        );
        if (!proceed) {
          e.target.value = '';
          return;
        }
      }

      // Import all items
      result.prompts.forEach((prompt) => addPrompt(prompt));
      result.tones.forEach((tone) => addTone(tone));
      result.folders.forEach((folder) => addFolder(folder));
      result.customAgents.forEach((agent) => addCustomAgent(agent));

      alert(
        t('team_template_import_success', {
          name: data.name,
          prompts: result.prompts.length,
          tones: result.tones.length,
          folders: result.folders.length,
          agents:
            result.customAgents.length > 0
              ? t('team_template_import_agents', {
                  count: result.customAgents.length,
                })
              : '',
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

  const handleDeleteTemplate = (templateId: string, templateName: string) => {
    const itemIds = getTemplateItemIds(
      templateId,
      prompts,
      tones,
      folders,
      customAgents,
    );

    const totalItems =
      itemIds.promptIds.length +
      itemIds.toneIds.length +
      itemIds.folderIds.length +
      itemIds.customAgentIds.length;

    const proceed = confirm(
      t('team_template_delete_confirm', {
        name: templateName,
        count: totalItems,
        prompts: itemIds.promptIds.length,
        tones: itemIds.toneIds.length,
        folders: itemIds.folderIds.length,
        agents: itemIds.customAgentIds.length,
      }),
    );

    if (!proceed) return;

    // Delete all items
    itemIds.promptIds.forEach((id) => deletePrompt(id));
    itemIds.toneIds.forEach((id) => deleteTone(id));
    itemIds.folderIds.forEach((id) => deleteFolder(id));
    itemIds.customAgentIds.forEach((id) => deleteCustomAgent(id));

    alert(
      t('team_template_delete_success', {
        name: templateName,
      }),
    );
  };

  // Get all imported templates
  const importedTemplates = getImportedTemplates(
    prompts,
    tones,
    folders,
    customAgents,
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in-fast"
      onClick={onClose}
    >
      <div
        className="relative w-full h-full max-h-[90vh] max-w-[900px] md:h-[85vh] bg-white dark:bg-[#212121] rounded-xl shadow-2xl overflow-hidden flex flex-col animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-4 md:px-6 py-3 md:py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0 mr-4">
              <div className="flex items-center gap-2">
                <h3 className="text-lg md:text-xl font-semibold text-gray-900 dark:text-white truncate">
                  {t('Team Templates')}
                </h3>
                <span className="px-2 py-0.5 text-xs font-semibold bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-400 rounded">
                  {t('Experimental')}
                </span>
              </div>
              <p className="hidden sm:block text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'Package your prompts, tones, and custom agents into a shareable file',
                )}
              </p>
            </div>
            <button
              onClick={onClose}
              className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              <IconX size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto space-y-8">
            {/* Info Banner */}
            <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
              <IconInfoCircle
                size={20}
                className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5"
              />
              <div className="flex-1 text-sm">
                <p className="text-blue-900 dark:text-blue-100 font-medium mb-1">
                  {t('What are Team Templates?')}
                </p>
                <p className="text-blue-800 dark:text-blue-200">
                  {t(
                    'Bundle your prompts, tones, folders, and custom agents into a single file you can share. This ensures everyone on your team uses the same settings and workflows.',
                  )}
                </p>
              </div>
            </div>

            {/* Export Section */}
            <div className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-6">
              <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('Export Template')}
              </h4>

              {/* Template Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('Template Name')} *
                </label>
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder={t('exampleMarketingTeamEngineering')}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-neutral-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Template Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {t('Description (Optional)')}
                </label>
                <textarea
                  value={templateDescription}
                  onChange={(e) => setTemplateDescription(e.target.value)}
                  placeholder={t(
                    'Describe what this template includes and when to use it...',
                  )}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-neutral-800 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>

              {/* What to Include */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                  {t('Include in Template')}
                </label>
                <div className="space-y-3">
                  {/* Prompts Section */}
                  {prompts.length > 0 && (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-neutral-800/50">
                        <input
                          type="checkbox"
                          checked={includePrompts}
                          onChange={(e) => {
                            setIncludePrompts(e.target.checked);
                            if (!e.target.checked) {
                              setShowPromptSelection(false);
                              setSelectedPromptIds([]);
                            }
                          }}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <IconSparkles
                          size={18}
                          className="text-gray-600 dark:text-gray-400"
                        />
                        <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white">
                          {t('Prompts')} ({prompts.length})
                        </span>
                        {includePrompts && prompts.length > 0 && (
                          <button
                            onClick={() =>
                              setShowPromptSelection(!showPromptSelection)
                            }
                            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            {showPromptSelection
                              ? t('Select All')
                              : t('Select Specific')}
                          </button>
                        )}
                      </div>
                      {includePrompts &&
                        showPromptSelection &&
                        prompts.length > 0 && (
                          <div className="max-h-48 overflow-y-auto p-3 space-y-2 bg-white dark:bg-neutral-900">
                            <div className="flex items-center gap-2 mb-2 pb-2 border-b border-gray-200 dark:border-gray-700">
                              <button
                                onClick={() =>
                                  setSelectedPromptIds(prompts.map((p) => p.id))
                                }
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {t('All')}
                              </button>
                              <span className="text-gray-400">|</span>
                              <button
                                onClick={() => setSelectedPromptIds([])}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {t('None')}
                              </button>
                              <span className="flex-1 text-xs text-gray-500 dark:text-gray-400 text-right">
                                {selectedPromptIds.length} {t('selected')}
                              </span>
                            </div>
                            {prompts.map((prompt) => (
                              <label
                                key={prompt.id}
                                className="flex items-center gap-2 p-2 hover:bg-gray-50 dark:hover:bg-neutral-800 rounded cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedPromptIds.includes(
                                    prompt.id,
                                  )}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedPromptIds([
                                        ...selectedPromptIds,
                                        prompt.id,
                                      ]);
                                    } else {
                                      setSelectedPromptIds(
                                        selectedPromptIds.filter(
                                          (id) => id !== prompt.id,
                                        ),
                                      );
                                    }
                                  }}
                                  className="w-3 h-3 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                                />
                                <span className="text-xs text-gray-900 dark:text-white truncate">
                                  {prompt.name}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                    </div>
                  )}

                  {/* Tones Section */}
                  {tones.length > 0 && (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-neutral-800/50">
                        <input
                          type="checkbox"
                          checked={includeTones}
                          onChange={(e) => {
                            setIncludeTones(e.target.checked);
                            if (!e.target.checked) {
                              setShowToneSelection(false);
                              setSelectedToneIds([]);
                            }
                          }}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <IconVolume
                          size={18}
                          className="text-gray-600 dark:text-gray-400"
                        />
                        <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white">
                          {t('Tones')} ({tones.length})
                        </span>
                        {includeTones && tones.length > 0 && (
                          <button
                            onClick={() =>
                              setShowToneSelection(!showToneSelection)
                            }
                            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                          >
                            {showToneSelection
                              ? t('Select All')
                              : t('Select Specific')}
                          </button>
                        )}
                      </div>
                      {includeTones &&
                        showToneSelection &&
                        tones.length > 0 && (
                          <div className="max-h-48 overflow-y-auto p-3 space-y-2 bg-white dark:bg-neutral-900">
                            <div className="flex items-center gap-2 mb-2 pb-2 border-b border-gray-200 dark:border-gray-700">
                              <button
                                onClick={() =>
                                  setSelectedToneIds(tones.map((t) => t.id))
                                }
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {t('All')}
                              </button>
                              <span className="text-gray-400">|</span>
                              <button
                                onClick={() => setSelectedToneIds([])}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {t('None')}
                              </button>
                              <span className="flex-1 text-xs text-gray-500 dark:text-gray-400 text-right">
                                {selectedToneIds.length} {t('selected')}
                              </span>
                            </div>
                            {tones.map((tone) => (
                              <label
                                key={tone.id}
                                className="flex items-center gap-2 p-2 hover:bg-gray-50 dark:hover:bg-neutral-800 rounded cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedToneIds.includes(tone.id)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedToneIds([
                                        ...selectedToneIds,
                                        tone.id,
                                      ]);
                                    } else {
                                      setSelectedToneIds(
                                        selectedToneIds.filter(
                                          (id) => id !== tone.id,
                                        ),
                                      );
                                    }
                                  }}
                                  className="w-3 h-3 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                                />
                                <span className="text-xs text-gray-900 dark:text-white truncate">
                                  {tone.name}
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                    </div>
                  )}

                  {/* Folders Section */}
                  {folders.filter(
                    (f) => f.type === 'prompt' || f.type === 'tone',
                  ).length > 0 && (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-neutral-800/50">
                        <input
                          type="checkbox"
                          checked={includeFolders}
                          onChange={(e) => setIncludeFolders(e.target.checked)}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white">
                          {t('Folders')} (
                          {
                            folders.filter(
                              (f) => f.type === 'prompt' || f.type === 'tone',
                            ).length
                          }
                          )
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Custom Agents Section */}
                  {customAgents && customAgents.length > 0 && (
                    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-neutral-800/50">
                        <input
                          type="checkbox"
                          checked={includeCustomAgents}
                          onChange={(e) =>
                            setIncludeCustomAgents(e.target.checked)
                          }
                          className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                        />
                        <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white">
                          {t('Custom Agents')} ({customAgents?.length || 0})
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Export Button */}
              <button
                onClick={handleExportTemplate}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium shadow-lg"
              >
                <IconFileExport size={18} />
                {t('Export Team Template')}
              </button>
            </div>

            {/* Import Section */}
            <div className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-6">
              <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('Import Template')}
              </h4>

              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t(
                  'Import a team template file to add prompts, tones, and configurations to your workspace',
                )}
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleFileChange}
                className="hidden"
              />

              <button
                onClick={handleImportClick}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-neutral-800 text-sm font-medium"
              >
                <IconUpload size={18} />
                {t('Import Team Template')}
              </button>
            </div>

            {/* Imported Templates Management */}
            {importedTemplates.length > 0 && (
              <div className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-6">
                <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {t('Imported Templates')}
                </h4>

                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t(
                    "Manage templates you've imported. You can delete all items from a template at once.",
                  )}
                </p>

                <div className="space-y-3">
                  {importedTemplates.map((template) => (
                    <div
                      key={template.templateId}
                      className="p-4 rounded-lg bg-gray-50 dark:bg-neutral-800/50 border border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2">
                            <h5 className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                              {template.templateName}
                            </h5>
                            <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded">
                              {template.itemCount.total} items
                            </span>
                          </div>
                          <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                            <span>
                              {t('Imported')}{' '}
                              {new Date(
                                template.importedAt,
                              ).toLocaleDateString()}
                            </span>
                            {template.itemCount.prompts > 0 && (
                              <span className="flex items-center gap-1">
                                <IconSparkles size={12} />
                                {template.itemCount.prompts}
                              </span>
                            )}
                            {template.itemCount.tones > 0 && (
                              <span className="flex items-center gap-1">
                                <IconVolume size={12} />
                                {template.itemCount.tones}
                              </span>
                            )}
                            {template.itemCount.folders > 0 && (
                              <span>
                                {template.itemCount.folders} {t('folders')}
                              </span>
                            )}
                            {template.itemCount.customAgents > 0 && (
                              <span>
                                {template.itemCount.customAgents} {t('agents')}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() =>
                            handleDeleteTemplate(
                              template.templateId,
                              template.templateName,
                            )
                          }
                          className="flex-shrink-0 p-2 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                          title={t('Delete template and all its items')}
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
