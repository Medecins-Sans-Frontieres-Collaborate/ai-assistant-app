'use client';

import {
  IconAlertCircle,
  IconCheck,
  IconLoader2,
  IconPlus,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import { FC, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  importCustomAgents,
  validateCustomAgentImport,
} from '@/lib/utils/app/export/customAgentExport';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { ApiError, apiClient } from '@/client/services';
import { CustomAgent } from '@/client/stores/settingsStore';

interface CustomAgentFormProps {
  onSave: (agent: CustomAgent) => void;
  onClose: () => void;
  existingAgent?: CustomAgent;
  existingAgents?: CustomAgent[];
}

export const CustomAgentForm: FC<CustomAgentFormProps> = ({
  onSave,
  onClose,
  existingAgent,
  existingAgents = [],
}) => {
  const t = useTranslations();
  const [mode, setMode] = useState<'create' | 'import'>(
    existingAgent ? 'create' : 'create',
  );
  const [name, setName] = useState(existingAgent?.name || '');
  const [agentId, setAgentId] = useState(existingAgent?.agentId || '');
  const [baseModelId, setBaseModelId] = useState<OpenAIModelID>(
    existingAgent?.baseModelId || OpenAIModelID.GPT_5_2_CHAT,
  );
  const [description, setDescription] = useState(
    existingAgent?.description || '',
  );
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [validationSuccess, setValidationSuccess] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Available base models (excluding disabled models)
  // Note: We allow models with isAgent=true because custom agents can be based on
  // agent-capable models like GPT-5. The baseModel provides configuration like
  // tokenLimit for message trimming, while the custom agentId determines behavior.
  const baseModels = Object.values(OpenAIModels).filter((m) => !m.isDisabled);

  const validateAgentId = (id: string): boolean => {
    // Azure AI Foundry agent IDs typically follow the pattern: asst_[alphanumeric]
    const agentIdPattern = /^asst_[A-Za-z0-9_-]+$/;
    return agentIdPattern.test(id);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setImportSuccess(null);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      const validation = validateCustomAgentImport(data);
      if (!validation.valid) {
        setError(validation.error || t('agents.invalidFileFormat'));
        return;
      }

      const { agents: importedAgents, conflicts } = importCustomAgents(
        validation.data!,
        existingAgents,
      );

      if (importedAgents.length === 0) {
        setError(t('agents.noAgentsInFile'));
        return;
      }

      if (conflicts.length > 0) {
        const confirmMessage = `The following agents have conflicts:\n\n${conflicts.join('\n')}\n\nImport anyway? This will create duplicates.`;
        if (!confirm(confirmMessage)) {
          return;
        }
      }

      // Save all imported agents
      importedAgents.forEach((agent) => {
        onSave(agent);
      });

      setImportSuccess(
        `Successfully imported ${importedAgents.length} agent${importedAgents.length > 1 ? 's' : ''}`,
      );

      // Close after a short delay
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      console.error('Import error:', error);
      setError(
        error instanceof Error ? error.message : t('agents.importFailed'),
      );
    } finally {
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const validateAgentConnection = async (): Promise<boolean> => {
    setIsValidating(true);
    setError(null);
    setValidationSuccess(false);

    try {
      await apiClient.post('/api/chat/agents/validate', {
        agentId: agentId.trim(),
      });

      setValidationSuccess(true);
      return true;
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.response?.details || err.message
          : err instanceof Error
            ? err.message
            : 'Validation failed';
      setError(message);
      return false;
    } finally {
      setIsValidating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setValidationSuccess(false);

    // Basic validation
    if (!name.trim()) {
      setError(t('agents.nameRequired'));
      return;
    }

    if (!agentId.trim()) {
      setError(t('agents.idRequired'));
      return;
    }

    if (!validateAgentId(agentId)) {
      setError(t('agents.invalidIdFormat'));
      return;
    }

    // Validate connection to agent
    const isValid = await validateAgentConnection();
    if (!isValid) {
      return; // Error already set by validateAgentConnection
    }

    const agent: CustomAgent = {
      id: existingAgent?.id || `agent-${Date.now()}`,
      name: name.trim(),
      agentId: agentId.trim(),
      baseModelId,
      description: description.trim() || undefined,
      createdAt: existingAgent?.createdAt || new Date().toISOString(),
    };

    onSave(agent);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white dark:bg-[#212121] rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {existingAgent
                ? t('agents.editCustomAgent')
                : t('agents.addCustomAgent')}
            </h3>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              {t('agents.experimental')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <IconX size={20} />
          </button>
        </div>

        {/* Mode Selector - Only show when creating new agent */}
        {!existingAgent && (
          <div className="px-6 pt-4 flex-shrink-0">
            <div className="flex gap-2 p-1 bg-gray-100 dark:bg-gray-800 rounded-lg">
              <button
                type="button"
                onClick={() => setMode('create')}
                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  mode === 'create'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                <IconPlus size={16} />
                {t('agents.createNew')}
              </button>
              <button
                type="button"
                onClick={() => setMode('import')}
                className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2 ${
                  mode === 'import'
                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                <IconUpload size={16} />
                {t('agents.import')}
              </button>
            </div>
          </div>
        )}

        {/* Import Mode */}
        {mode === 'import' && !existingAgent && (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileImport}
              className="hidden"
            />

            {/* Import Success */}
            {importSuccess && (
              <div className="p-2.5 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800 flex items-center gap-2">
                <IconCheck
                  size={16}
                  className="flex-shrink-0 text-green-600 dark:text-green-400"
                />
                <span className="text-sm text-green-700 dark:text-green-300">
                  {importSuccess}
                </span>
              </div>
            )}

            {/* Import Error */}
            {error && (
              <div className="p-2.5 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800 flex items-center gap-2">
                <IconAlertCircle
                  size={16}
                  className="flex-shrink-0 text-red-600 dark:text-red-400"
                />
                <span className="text-sm text-red-700 dark:text-red-300">
                  {error}
                </span>
              </div>
            )}

            {/* Import Instructions */}
            <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg text-center">
              <IconUpload
                size={40}
                className="mx-auto mb-3 text-gray-400 dark:text-gray-600"
              />
              <h4 className="text-sm font-medium text-gray-900 dark:text-white mb-1">
                {t('agents.importCustomAgents')}
              </h4>
              <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">
                {t('agents.importFileDescription')}
              </p>
              <button
                type="button"
                onClick={handleImportClick}
                className="w-full py-2.5 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 font-medium"
              >
                <IconUpload size={18} />
                {t('agents.chooseFile')}
              </button>
            </div>

            {/* Collapsible Notice */}
            <button
              type="button"
              onClick={() => setShowNotice(!showNotice)}
              className="w-full p-2 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800 flex items-center justify-between text-left hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
            >
              <div className="flex items-center gap-2">
                <IconAlertCircle
                  size={16}
                  className="text-amber-600 dark:text-amber-400 flex-shrink-0"
                />
                <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  {t('common.importantInformation')}
                </span>
              </div>
              <IconX
                size={14}
                className={`text-amber-600 dark:text-amber-400 transition-transform ${showNotice ? 'rotate-0' : 'rotate-45'}`}
              />
            </button>

            {showNotice && (
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800 -mt-1">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t('agents.importantInfo')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Create Mode - Original Form */}
        {mode === 'create' && (
          <form
            onSubmit={handleSubmit}
            className="flex-1 flex flex-col overflow-hidden"
          >
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {/* Validation Success */}
              {validationSuccess && !error && (
                <div className="p-2.5 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800 flex items-center gap-2">
                  <IconCheck
                    size={16}
                    className="flex-shrink-0 text-green-600 dark:text-green-400"
                  />
                  <span className="text-sm text-green-700 dark:text-green-300">
                    {t('agents.validatedSuccess')}
                  </span>
                </div>
              )}

              {/* Validation Error */}
              {error && (
                <div className="p-2.5 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800 flex items-center gap-2">
                  <IconAlertCircle
                    size={16}
                    className="flex-shrink-0 text-red-600 dark:text-red-400"
                  />
                  <span className="text-sm text-red-700 dark:text-red-300">
                    {error}
                  </span>
                </div>
              )}

              {/* Two-column layout for Name and Agent ID */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('agents.agentName')}{' '}
                    <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('agents.myResearchAssistant')}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2A2A2A] text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('agents.baseModel')}
                  </label>
                  <select
                    value={baseModelId}
                    onChange={(e) =>
                      setBaseModelId(e.target.value as OpenAIModelID)
                    }
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2A2A2A] text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {baseModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('agents.agentId')} <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  placeholder={t('agents.agentIdExample')}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2A2A2A] text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {t('agents.formatDescription')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('agents.descriptionOptional')}
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('agents.descriptionPlaceholder')}
                  rows={2}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-[#2A2A2A] text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>

              {/* Collapsible Notice */}
              <button
                type="button"
                onClick={() => setShowNotice(!showNotice)}
                className="w-full p-2 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800 flex items-center justify-between text-left hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <IconAlertCircle
                    size={16}
                    className="text-amber-600 dark:text-amber-400 flex-shrink-0"
                  />
                  <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    {t('common.importantInformation')}
                  </span>
                </div>
                <IconX
                  size={14}
                  className={`text-amber-600 dark:text-amber-400 transition-transform ${showNotice ? 'rotate-0' : 'rotate-45'}`}
                />
              </button>

              {showNotice && (
                <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800 -mt-1">
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t('agents.importantInfo')}
                  </p>
                </div>
              )}
            </div>

            {/* Actions - Fixed at bottom */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
              <button
                type="button"
                onClick={onClose}
                disabled={isValidating}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('agents.cancel')}
              </button>
              <button
                type="submit"
                disabled={isValidating}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isValidating ? (
                  <>
                    <IconLoader2 size={16} className="animate-spin" />
                    {t('agents.validating')}
                  </>
                ) : existingAgent ? (
                  t('agents.updateAgent')
                ) : (
                  t('agents.addAgent')
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
