'use client';

import {
  IconAlertCircle,
  IconDownload,
  IconEdit,
  IconFileExport,
  IconRobot,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { FC, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  exportCustomAgents,
  exportSingleCustomAgent,
  importCustomAgents,
  validateCustomAgentImport,
} from '@/lib/utils/app/export/customAgentExport';

import { OpenAIModels } from '@/types/openai';

import {
  ClaudeIcon,
  DeepSeekIcon,
  MetaIcon,
  OpenAIIcon,
  XAIIcon,
} from '@/components/Icons/providers';

import { CustomAgent } from '@/client/stores/settingsStore';

interface CustomAgentListProps {
  agents: CustomAgent[];
  onEdit: (agent: CustomAgent) => void;
  onDelete: (agentId: string) => void;
  onImport: (agents: CustomAgent[]) => void;
  onSelect: (agent: CustomAgent) => void;
  selectedModelId?: string;
}

export const CustomAgentList: FC<CustomAgentListProps> = ({
  agents,
  onEdit,
  onDelete,
  onImport,
  onSelect,
  selectedModelId,
}) => {
  const t = useTranslations();
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helper function to get provider icon
  const getProviderIcon = (provider?: string) => {
    const iconProps = { className: 'w-4 h-4 flex-shrink-0' };
    switch (provider) {
      case 'openai':
        return <OpenAIIcon {...iconProps} />;
      case 'deepseek':
        return <DeepSeekIcon {...iconProps} />;
      case 'xai':
        return <XAIIcon {...iconProps} />;
      case 'meta':
        return <MetaIcon {...iconProps} />;
      case 'anthropic':
        return <ClaudeIcon {...iconProps} />;
      default:
        return null;
    }
  };

  const handleDelete = (agentId: string) => {
    if (deleteConfirm === agentId) {
      onDelete(agentId);
      setDeleteConfirm(null);
    } else {
      setDeleteConfirm(agentId);
      // Reset confirmation after 3 seconds
      setTimeout(() => setDeleteConfirm(null), 3000);
    }
  };

  const handleExportAll = () => {
    exportCustomAgents(agents);
  };

  const handleExportSingle = (agent: CustomAgent) => {
    exportSingleCustomAgent(agent);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportError(null);
    setImportSuccess(null);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      const validation = validateCustomAgentImport(data);
      if (!validation.valid) {
        setImportError(validation.error || 'Invalid file format');
        return;
      }

      const { agents: importedAgents, conflicts } = importCustomAgents(
        validation.data!,
        agents,
      );

      if (importedAgents.length === 0) {
        setImportError('No agents found in the import file');
        return;
      }

      if (conflicts.length > 0) {
        const confirmMessage = `The following agents have conflicts:\n\n${conflicts.join('\n')}\n\nImport anyway? This will create duplicates.`;
        if (!confirm(confirmMessage)) {
          return;
        }
      }

      onImport(importedAgents);
      setImportSuccess(
        `Successfully imported ${importedAgents.length} agent${importedAgents.length > 1 ? 's' : ''}`,
      );
      setTimeout(() => setImportSuccess(null), 5000);
    } catch (error) {
      console.error('Import error:', error);
      setImportError(
        error instanceof Error ? error.message : 'Failed to import file',
      );
    } finally {
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  if (agents.length === 0) {
    return (
      <>
        <div className="mb-4 flex justify-end">
          <button
            onClick={handleImportClick}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <IconUpload size={16} />
            Import Agents
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileImport}
            className="hidden"
          />
        </div>

        {importError && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800 flex items-start">
            <IconAlertCircle
              size={18}
              className="mr-2 mt-0.5 flex-shrink-0 text-red-600 dark:text-red-400"
            />
            <span className="text-sm text-red-700 dark:text-red-300">
              {importError}
            </span>
          </div>
        )}

        <div className="p-8 text-center">
          <IconRobot
            size={48}
            className="mx-auto mb-3 text-gray-400 dark:text-gray-600"
          />
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No custom agents configured yet.
          </p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            Add an agent to get started with Azure AI Foundry.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileImport}
        className="hidden"
      />

      <div className="mb-4 flex justify-between items-center">
        <span className="text-sm text-gray-600 dark:text-gray-400">
          {agents.length} agent{agents.length > 1 ? 's' : ''}
        </span>
        <div className="flex gap-2">
          <button
            onClick={handleImportClick}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            <IconUpload size={16} />
            Import
          </button>
          <button
            onClick={handleExportAll}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <IconFileExport size={16} />
            Export All
          </button>
        </div>
      </div>

      {importError && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800 flex items-start">
          <IconAlertCircle
            size={18}
            className="mr-2 mt-0.5 flex-shrink-0 text-red-600 dark:text-red-400"
          />
          <span className="text-sm text-red-700 dark:text-red-300">
            {importError}
          </span>
        </div>
      )}

      {importSuccess && (
        <div className="mb-4 p-3 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800 flex items-start">
          <IconAlertCircle
            size={18}
            className="mr-2 mt-0.5 flex-shrink-0 text-green-600 dark:text-green-400"
          />
          <span className="text-sm text-green-700 dark:text-green-300">
            {importSuccess}
          </span>
        </div>
      )}

      <div className="space-y-2">
        {agents.map((agent) => {
          const baseModel = OpenAIModels[agent.baseModelId];
          const isDeleting = deleteConfirm === agent.id;
          const isSelected = selectedModelId === `custom-${agent.id}`;

          return (
            <div
              key={agent.id}
              onClick={() => onSelect(agent)}
              className={`p-4 bg-white dark:bg-[#2A2A2A] border-2 rounded-lg transition-colors cursor-pointer ${
                isSelected
                  ? 'border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-blue-900/10'
                  : 'border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {getProviderIcon(baseModel?.provider)}
                    <h4 className="font-medium text-gray-900 dark:text-white">
                      {agent.name}
                    </h4>
                  </div>

                  {agent.description && (
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                      {agent.description}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
                    <div>
                      <span className="font-medium">Agent ID:</span>{' '}
                      <code className="bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                        {agent.agentId}
                      </code>
                    </div>
                    <div>
                      <span className="font-medium">Base Model:</span>{' '}
                      {baseModel?.name || 'Unknown'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 ml-4">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleExportSingle(agent);
                    }}
                    className="p-2 text-gray-500 hover:text-green-600 dark:text-gray-400 dark:hover:text-green-400 transition-colors"
                    title={t('agents.exportAgent')}
                  >
                    <IconDownload size={18} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(agent);
                    }}
                    className="p-2 text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 transition-colors"
                    title={t('agents.editAgent')}
                  >
                    <IconEdit size={18} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(agent.id);
                    }}
                    className={`p-2 transition-colors ${
                      isDeleting
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400'
                    }`}
                    title={
                      isDeleting ? 'Click again to confirm' : 'Delete agent'
                    }
                  >
                    <IconTrash size={18} />
                  </button>
                </div>
              </div>

              {isDeleting && (
                <div className="mt-3 p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800 flex items-start">
                  <IconAlertCircle
                    size={16}
                    className="mr-2 mt-0.5 flex-shrink-0 text-red-600 dark:text-red-400"
                  />
                  <span className="text-xs text-red-700 dark:text-red-300">
                    Click delete again to confirm removal
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
};
