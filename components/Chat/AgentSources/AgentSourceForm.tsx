'use client';

import {
  IconAlertCircle,
  IconCheck,
  IconLoader2,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import { AgentSource } from '@/client/stores/settingsStore';

interface AgentSourceFormProps {
  onSave: (source: AgentSource) => void;
  onClose: () => void;
  existingSource?: AgentSource;
}

interface BrowseItem {
  id?: string;
  name: string;
  resourceGroup?: string;
  location?: string;
}

function parseResourcePath(path: string) {
  const match = path.match(
    /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/[^/]+\/[^/]+\/([^/]+)(?:\/projects\/([^/]+))?/,
  );
  if (!match) return null;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    accountName: match[3],
    projectName: match[4] || 'default',
  };
}

export const AgentSourceForm: FC<AgentSourceFormProps> = ({
  onSave,
  onClose,
  existingSource,
}) => {
  const t = useTranslations('agents');
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState(existingSource?.name || '');
  const [error, setError] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    agentCount: number;
  } | null>(null);

  const existing = existingSource
    ? parseResourcePath(existingSource.resourcePath)
    : null;

  const [inputMode, setInputMode] = useState<'browse' | 'manual'>('browse');

  // Browse state
  const [subscriptions, setSubscriptions] = useState<BrowseItem[]>([]);
  const [accounts, setAccounts] = useState<BrowseItem[]>([]);
  const [projects, setProjects] = useState<BrowseItem[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // Selected values
  const [subscriptionId, setSubscriptionId] = useState(
    existing?.subscriptionId || '',
  );
  const [resourceGroup, setResourceGroup] = useState(
    existing?.resourceGroup || '',
  );
  const [accountName, setAccountName] = useState(existing?.accountName || '');
  const [projectName, setProjectName] = useState(
    existing?.projectName || 'default',
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  // Load subscriptions on mount
  useEffect(() => {
    if (!mounted) return;
    setLoadingSubs(true);
    fetch('/api/agents/browse?level=subscriptions')
      .then((r) => r.json())
      .then((data) => setSubscriptions(data.items || []))
      .catch(() => setSubscriptions([]))
      .finally(() => setLoadingSubs(false));
  }, [mounted]);

  // Load accounts when subscription changes
  const loadAccounts = useCallback((subId: string) => {
    if (!subId) {
      setAccounts([]);
      return;
    }
    setLoadingAccounts(true);
    setAccounts([]);
    setProjects([]);
    fetch(`/api/agents/browse?level=accounts&subscriptionId=${subId}`)
      .then((r) => r.json())
      .then((data) => setAccounts(data.items || []))
      .catch(() => setAccounts([]))
      .finally(() => setLoadingAccounts(false));
  }, []);

  // Load projects when account changes
  const loadProjects = useCallback(
    (subId: string, rg: string, acct: string) => {
      if (!subId || !rg || !acct) {
        setProjects([]);
        return;
      }
      setLoadingProjects(true);
      setProjects([]);
      fetch(
        `/api/agents/browse?level=projects&subscriptionId=${subId}&resourceGroup=${rg}&accountName=${acct}`,
      )
        .then((r) => r.json())
        .then((data) => setProjects(data.items || []))
        .catch(() => setProjects([]))
        .finally(() => setLoadingProjects(false));
    },
    [],
  );

  // Auto-load accounts for existing source
  useEffect(() => {
    if (existing?.subscriptionId) {
      loadAccounts(existing.subscriptionId);
    }
  }, [existing?.subscriptionId, loadAccounts]);

  // Auto-load projects for existing source
  useEffect(() => {
    if (
      existing?.subscriptionId &&
      existing?.resourceGroup &&
      existing?.accountName
    ) {
      loadProjects(
        existing.subscriptionId,
        existing.resourceGroup,
        existing.accountName,
      );
    }
  }, [
    existing?.subscriptionId,
    existing?.resourceGroup,
    existing?.accountName,
    loadProjects,
  ]);

  const buildPath = () =>
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${accountName}/projects/${projectName || 'default'}`;

  const validateSource = async (path: string): Promise<boolean> => {
    setIsValidating(true);
    setError('');
    setValidationResult(null);

    try {
      const params = new URLSearchParams({ sources: path });
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

    if (!subscriptionId || !resourceGroup || !accountName) {
      setError('Select a subscription, account, and project.');
      return;
    }

    const finalPath = buildPath();
    const isValid = await validateSource(finalPath);
    if (!isValid) return;

    const source: AgentSource = {
      id: existingSource?.id || crypto.randomUUID(),
      name: name.trim(),
      resourcePath: finalPath.trim(),
      createdAt: existingSource?.createdAt || new Date().toISOString(),
    };

    onSave(source);
  };

  const isFormFilled = !!(subscriptionId && resourceGroup && accountName);

  if (!mounted) return null;

  const selectClass =
    'w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none appearance-none';

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg mx-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
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

          {/* Mode toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-900 dark:text-white">
              Foundry Project
            </label>
            <button
              type="button"
              onClick={() =>
                setInputMode(inputMode === 'browse' ? 'manual' : 'browse')
              }
              className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              {inputMode === 'browse' ? 'Enter manually' : 'Browse resources'}
            </button>
          </div>

          {inputMode === 'manual' ? (
            /* Manual entry fields */
            <div className="space-y-3">
              <div>
                <label className="mb-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  Subscription ID
                </label>
                <input
                  type="text"
                  value={subscriptionId}
                  onChange={(e) => {
                    setSubscriptionId(e.target.value.trim());
                    setValidationResult(null);
                  }}
                  placeholder="e49ac66c-c18d-4586-b132-8f201de8f2c2"
                  className={selectClass}
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  Resource Group
                </label>
                <input
                  type="text"
                  value={resourceGroup}
                  onChange={(e) => {
                    setResourceGroup(e.target.value.trim());
                    setValidationResult(null);
                  }}
                  placeholder="rg-my-foundry"
                  className={selectClass}
                  spellCheck={false}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-0.5 block text-xs text-gray-500 dark:text-gray-400">
                    Account Name
                  </label>
                  <input
                    type="text"
                    value={accountName}
                    onChange={(e) => {
                      setAccountName(e.target.value.trim());
                      setValidationResult(null);
                    }}
                    placeholder="my-foundry-account"
                    className={selectClass}
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className="mb-0.5 block text-xs text-gray-500 dark:text-gray-400">
                    Project Name
                  </label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => {
                      setProjectName(e.target.value.trim());
                      setValidationResult(null);
                    }}
                    placeholder="default"
                    className={selectClass}
                    spellCheck={false}
                  />
                </div>
              </div>
            </div>
          ) : (
            /* Browse dropdowns */
            <>
              {/* Subscription */}
              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                  Subscription
                </label>
                {loadingSubs ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-1.5">
                    <IconLoader2 size={14} className="animate-spin" />
                    Loading subscriptions...
                  </div>
                ) : (
                  <select
                    value={subscriptionId}
                    onChange={(e) => {
                      const subId = e.target.value;
                      setSubscriptionId(subId);
                      setAccountName('');
                      setResourceGroup('');
                      setProjectName('default');
                      setValidationResult(null);
                      loadAccounts(subId);
                    }}
                    className={selectClass}
                  >
                    <option value="">Select a subscription...</option>
                    {subscriptions.map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {sub.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Account */}
              {subscriptionId && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
                    Foundry Account
                  </label>
                  {loadingAccounts ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      <IconLoader2 size={14} className="animate-spin" />
                      Loading accounts...
                    </div>
                  ) : accounts.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      No Foundry accounts found in this subscription.
                    </p>
                  ) : (
                    <select
                      value={accountName}
                      onChange={(e) => {
                        const acct = accounts.find(
                          (a) => a.name === e.target.value,
                        );
                        setAccountName(e.target.value);
                        setResourceGroup(acct?.resourceGroup || '');
                        setProjectName('default');
                        setValidationResult(null);
                        if (acct) {
                          loadProjects(
                            subscriptionId,
                            acct.resourceGroup || '',
                            e.target.value,
                          );
                        }
                      }}
                      className={selectClass}
                    >
                      <option value="">Select an account...</option>
                      {accounts.map((acct) => (
                        <option key={acct.name} value={acct.name}>
                          {acct.name}
                          {acct.location ? ` (${acct.location})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {/* Project */}
              {accountName && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">
                    Project
                  </label>
                  {loadingProjects ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      <IconLoader2 size={14} className="animate-spin" />
                      Loading projects...
                    </div>
                  ) : projects.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      No projects found. Using &quot;default&quot;.
                    </p>
                  ) : (
                    <select
                      value={projectName}
                      onChange={(e) => {
                        setProjectName(e.target.value);
                        setValidationResult(null);
                      }}
                      className={selectClass}
                    >
                      {projects.map((proj) => (
                        <option key={proj.name} value={proj.name}>
                          {proj.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </>
          )}
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
            disabled={isValidating || !name.trim() || !isFormFilled}
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
