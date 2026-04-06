'use client';

import {
  IconAlertCircle,
  IconCheck,
  IconLoader2,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { FC, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import { AgentSource } from '@/client/stores/settingsStore';

interface AgentSourceFormProps {
  onSave: (source: AgentSource) => void;
  onClose: () => void;
  existingSource?: AgentSource;
}

export const AgentSourceForm: FC<AgentSourceFormProps> = ({
  onSave,
  onClose,
  existingSource,
}) => {
  const t = useTranslations('agents');
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState(existingSource?.name || '');
  const [resourcePath, setResourcePath] = useState(
    existingSource?.resourcePath || '',
  );
  const [error, setError] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    agentCount: number;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const validateSource = async (): Promise<boolean> => {
    setIsValidating(true);
    setError('');
    setValidationResult(null);

    try {
      const params = new URLSearchParams({ sources: resourcePath });
      const response = await fetch(`/api/agents?${params.toString()}`);

      if (!response.ok) {
        setError(t('connectionFailed'));
        return false;
      }

      const data = await response.json();
      const agentCount = data.agents?.length ?? 0;
      setValidationResult({ valid: true, agentCount });
      return true;
    } catch {
      setError(t('connectionFailed'));
      return false;
    } finally {
      setIsValidating(false);
    }
  };

  const handleSubmit = async () => {
    setError('');

    if (!name.trim()) {
      setError(t('nameRequired'));
      return;
    }

    if (!resourcePath.trim()) {
      setError(t('pathRequired'));
      return;
    }

    if (!resourcePath.startsWith('/subscriptions/')) {
      setError(t('pathInvalidFormat'));
      return;
    }

    const isValid = await validateSource();
    if (!isValid) return;

    const source: AgentSource = {
      id: existingSource?.id || crypto.randomUUID(),
      name: name.trim(),
      resourcePath: resourcePath.trim(),
      createdAt: existingSource?.createdAt || new Date().toISOString(),
    };

    onSave(source);
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg mx-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {existingSource
              ? t('editConnection') || 'Edit Connection'
              : t('connectFoundryProject')}
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <IconX size={20} />
          </button>
        </div>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
          {t('connectFoundryDescription')}
        </p>

        {/* Error */}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-400">
            <IconAlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Validation success */}
        {validationResult?.valid && (
          <div className="mb-4 flex items-start gap-2 rounded-lg bg-green-50 dark:bg-green-900/20 p-3 text-sm text-green-700 dark:text-green-400">
            <IconCheck size={16} className="shrink-0 mt-0.5" />
            <span>
              {validationResult.agentCount > 0
                ? t('connectionSuccessAgents', {
                    count: validationResult.agentCount,
                  })
                : t('connectionSuccessEmpty')}
            </span>
          </div>
        )}

        {/* Form */}
        <div className="space-y-4">
          {/* Source Name */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              {t('nameLabel')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Resource Path */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
              {t('foundryProjectPath')}
            </label>
            <input
              type="text"
              value={resourcePath}
              onChange={(e) => {
                setResourcePath(e.target.value.replace(/\s+/g, ''));
                setValidationResult(null);
              }}
              placeholder="Paste the Resource ID from Azure Portal"
              className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
              spellCheck={false}
            />
            {resourcePath && resourcePath.includes('/') ? (
              <div className="mt-2 rounded-md bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs font-mono text-gray-500 dark:text-gray-400 space-y-0.5">
                {(() => {
                  const match = resourcePath.match(
                    /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/[^/]+\/[^/]+\/([^/]+)(?:\/projects\/([^/]+))?/,
                  );
                  if (!match)
                    return (
                      <span className="text-amber-500">
                        Could not parse path — check the format
                      </span>
                    );
                  return (
                    <>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">
                          Subscription:
                        </span>{' '}
                        <span className="text-gray-700 dark:text-gray-300">
                          {match[1]}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">
                          Resource Group:
                        </span>{' '}
                        <span className="text-gray-700 dark:text-gray-300">
                          {match[2]}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400 dark:text-gray-500">
                          Account:
                        </span>{' '}
                        <span className="text-gray-700 dark:text-gray-300">
                          {match[3]}
                        </span>
                      </div>
                      {match[4] && (
                        <div>
                          <span className="text-gray-400 dark:text-gray-500">
                            Project:
                          </span>{' '}
                          <span className="text-gray-700 dark:text-gray-300">
                            {match[4]}
                          </span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            ) : (
              <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                {t('foundryProjectPathHelp')}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={isValidating || !name.trim() || !resourcePath.trim()}
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isValidating ? (
              <>
                <IconLoader2 size={16} className="animate-spin" />
                {t('checkingConnection')}
              </>
            ) : (
              <>
                <IconPlus size={16} />
                {existingSource ? t('save') || 'Save' : t('connect')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
