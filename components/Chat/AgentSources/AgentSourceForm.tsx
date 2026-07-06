'use client';

import {
  IconAlertCircle,
  IconCheck,
  IconInfoCircle,
  IconLoader2,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
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
  // Feature flag: when off, hide the "browse Azure resources" discovery affordance
  // and require manual resource-path entry. Fail-open (unset ⇒ enabled), mirroring
  // the `exploreBots` pattern in ModelSelect.tsx. Served `false` in prod until the
  // agent-discovery rollout is announced.
  const { agentSourceBrowse } = useFlags();
  const isBrowseEnabled = agentSourceBrowse !== false;
  const [mounted, setMounted] = useState(false);
  const [name, setName] = useState(existingSource?.name || '');
  // Treat an existing source's name as user-owned so autofill never clobbers it.
  const [nameEdited, setNameEdited] = useState(!!existingSource);
  const [error, setError] = useState('');
  // Per-field validation messages surfaced when the user attempts to submit an
  // incomplete form (the top `error` banner stays for connection failures).
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    subscription?: string;
    account?: string;
  }>({});
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    agentCount: number;
  } | null>(null);

  const existing = existingSource
    ? parseResourcePath(existingSource.resourcePath)
    : null;

  const [inputMode, setInputMode] = useState<'browse' | 'manual'>(
    isBrowseEnabled ? 'browse' : 'manual',
  );

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

  // Load subscriptions on mount (skipped when browse discovery is disabled)
  useEffect(() => {
    if (!mounted || !isBrowseEnabled) return;
    setLoadingSubs(true);
    fetch('/api/agents/browse?level=subscriptions')
      .then((r) => r.json())
      .then((data) => setSubscriptions(data.items || []))
      .catch(() => setSubscriptions([]))
      .finally(() => setLoadingSubs(false));
  }, [mounted, isBrowseEnabled]);

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

  // Auto-select the only subscription so single-tenant users don't have to.
  useEffect(() => {
    if (subscriptions.length === 1 && !subscriptionId) {
      const subId = subscriptions[0].id || '';
      setSubscriptionId(subId);
      loadAccounts(subId);
    }
  }, [subscriptions, subscriptionId, loadAccounts]);

  // Auto-select the only Foundry account; derive its resource group, kick off
  // project loading, and seed the connection name (until the user edits it).
  useEffect(() => {
    if (accounts.length === 1 && !accountName) {
      const acct = accounts[0];
      setAccountName(acct.name);
      setResourceGroup(acct.resourceGroup || '');
      if (!nameEdited) setName(acct.name);
      loadProjects(subscriptionId, acct.resourceGroup || '', acct.name);
    }
  }, [accounts, accountName, nameEdited, subscriptionId, loadProjects]);

  // Keep the projects <select> honest: it has no placeholder and is controlled
  // by `projectName` (initial 'default'). If the discovered projects don't
  // include the current value, the control would show its first option while
  // state lags behind — so buildPath() could save the wrong project. Sync to
  // the first real project, and seed the name from a non-default project.
  useEffect(() => {
    if (projects.length > 0 && !projects.some((p) => p.name === projectName)) {
      const first = projects[0].name;
      setProjectName(first);
      if (!nameEdited && first !== 'default') setName(first);
    }
  }, [projects, projectName, nameEdited]);

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

    // Surface every missing required field at once, inline, so the user always
    // learns what's blocking submission instead of facing a dead disabled button.
    const errors: typeof fieldErrors = {};
    if (!name.trim()) errors.name = t('nameRequired');
    if (!subscriptionId) errors.subscription = t('subscriptionRequired');
    if (!accountName) errors.account = t('accountRequired');

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    // resourceGroup is derived from the chosen account, so it should always be
    // present here; guard as a fallback rather than silently building a bad path.
    if (!resourceGroup) {
      setError(t('selectAllRequired'));
      return;
    }

    const finalPath = buildPath();
    const isValid = await validateSource(finalPath);
    if (!isValid) return;

    const source: AgentSource = {
      id: existingSource?.id || globalThis.crypto.randomUUID(),
      name: name.trim(),
      resourcePath: finalPath.trim(),
      createdAt: existingSource?.createdAt || new Date().toISOString(),
    };

    onSave(source);
  };

  if (!mounted) return null;

  const selectClass =
    'w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none appearance-none';

  // Same as selectClass but without a baked-in border color, so callers can pick
  // gray vs. red via fieldBorder() without two same-property classes fighting.
  const selectBase =
    'w-full rounded-lg border bg-gray-50 dark:bg-gray-800 px-3 py-1.5 text-sm text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none appearance-none';
  const fieldBorder = (hasError?: string) =>
    hasError
      ? 'border-red-400 dark:border-red-500'
      : 'border-gray-200 dark:border-gray-700';
  const fieldErrorText = (message?: string) =>
    message ? (
      <p className="mt-1 text-xs text-red-600 dark:text-red-400">{message}</p>
    ) : null;
  const requiredMark = <span className="text-red-500">*</span>;

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
            {existingSource ? t('editConnection') : t('connectFoundryProject')}
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
              {t('nameLabel')} {requiredMark}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
                setFieldErrors((prev) => ({ ...prev, name: undefined }));
              }}
              placeholder={t('namePlaceholder')}
              className={`w-full rounded-lg border ${fieldBorder(
                fieldErrors.name,
              )} bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none`}
            />
            {fieldErrorText(fieldErrors.name)}
          </div>

          {/* Mode toggle */}
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-gray-900 dark:text-white">
              {t('foundryProjectLabel')}
            </label>
            {isBrowseEnabled && (
              <button
                type="button"
                onClick={() =>
                  setInputMode(inputMode === 'browse' ? 'manual' : 'browse')
                }
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
              >
                {inputMode === 'browse'
                  ? t('enterManually')
                  : t('browseResources')}
              </button>
            )}
          </div>

          {inputMode === 'manual' ? (
            /* Manual entry fields */
            <div className="space-y-3">
              <div>
                <label className="mb-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  {t('subscriptionIdLabel')} {requiredMark}
                </label>
                <input
                  type="text"
                  value={subscriptionId}
                  onChange={(e) => {
                    setSubscriptionId(e.target.value.trim());
                    setValidationResult(null);
                    setFieldErrors((prev) => ({
                      ...prev,
                      subscription: undefined,
                    }));
                  }}
                  placeholder="e49ac66c-c18d-4586-b132-8f201de8f2c2"
                  className={`${selectBase} ${fieldBorder(fieldErrors.subscription)}`}
                  spellCheck={false}
                />
                {fieldErrorText(fieldErrors.subscription)}
              </div>
              <div>
                <label className="mb-0.5 block text-xs text-gray-500 dark:text-gray-400">
                  {t('resourceGroupLabel')}
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
                    {t('accountNameLabel')} {requiredMark}
                  </label>
                  <input
                    type="text"
                    value={accountName}
                    onChange={(e) => {
                      const acct = e.target.value.trim();
                      setAccountName(acct);
                      setValidationResult(null);
                      setFieldErrors((prev) => ({
                        ...prev,
                        account: undefined,
                      }));
                      if (!nameEdited) setName(acct);
                    }}
                    placeholder="my-foundry-account"
                    className={`${selectBase} ${fieldBorder(fieldErrors.account)}`}
                    spellCheck={false}
                  />
                  {fieldErrorText(fieldErrors.account)}
                </div>
                <div>
                  <label className="mb-0.5 block text-xs text-gray-500 dark:text-gray-400">
                    {t('projectNameLabel')}
                  </label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => {
                      const proj = e.target.value.trim();
                      setProjectName(proj);
                      setValidationResult(null);
                      if (!nameEdited && proj && proj !== 'default') {
                        setName(proj);
                      }
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
                <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-900 dark:text-white">
                  {t('labelSubscription')} {requiredMark}
                  <span className="group/tt relative inline-flex items-center">
                    <IconInfoCircle
                      size={14}
                      className="text-gray-400 dark:text-gray-500 cursor-help"
                    />
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 w-64 rounded bg-gray-900 px-2 py-1 text-xs font-normal text-white opacity-0 shadow-lg transition-opacity group-hover/tt:opacity-100 dark:bg-gray-700">
                      {t('tooltipSubscription')}
                    </span>
                  </span>
                </label>
                {loadingSubs ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-1.5">
                    <IconLoader2 size={14} className="animate-spin" />
                    {t('loadingSubscriptions')}
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
                      setFieldErrors((prev) => ({
                        ...prev,
                        subscription: undefined,
                      }));
                      loadAccounts(subId);
                    }}
                    className={`${selectBase} ${fieldBorder(fieldErrors.subscription)}`}
                  >
                    <option value="">{t('selectSubscription')}</option>
                    {subscriptions.map((sub) => (
                      <option key={sub.id} value={sub.id}>
                        {sub.name}
                      </option>
                    ))}
                  </select>
                )}
                {fieldErrorText(fieldErrors.subscription)}
              </div>

              {/* Account */}
              {subscriptionId && (
                <div>
                  <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-900 dark:text-white">
                    {t('labelFoundryAccount')} {requiredMark}
                    <span className="group/tt relative inline-flex items-center">
                      <IconInfoCircle
                        size={14}
                        className="text-gray-400 dark:text-gray-500 cursor-help"
                      />
                      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 w-64 rounded bg-gray-900 px-2 py-1 text-xs font-normal text-white opacity-0 shadow-lg transition-opacity group-hover/tt:opacity-100 dark:bg-gray-700">
                        {t('tooltipFoundryAccount')}
                      </span>
                    </span>
                  </label>
                  {loadingAccounts ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      <IconLoader2 size={14} className="animate-spin" />
                      {t('loadingAccounts')}
                    </div>
                  ) : accounts.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      {t('noAccountsFound')}
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
                        setFieldErrors((prev) => ({
                          ...prev,
                          account: undefined,
                        }));
                        if (!nameEdited && e.target.value) {
                          setName(e.target.value);
                        }
                        if (acct) {
                          loadProjects(
                            subscriptionId,
                            acct.resourceGroup || '',
                            e.target.value,
                          );
                        }
                      }}
                      className={`${selectBase} ${fieldBorder(fieldErrors.account)}`}
                    >
                      <option value="">{t('selectAccount')}</option>
                      {accounts.map((acct) => (
                        <option key={acct.name} value={acct.name}>
                          {acct.name}
                          {acct.location ? ` (${acct.location})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  {fieldErrorText(fieldErrors.account)}
                </div>
              )}

              {/* Project */}
              {accountName && (
                <div>
                  <label className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-900 dark:text-white">
                    {t('labelProject')}
                    <span className="group/tt relative inline-flex items-center">
                      <IconInfoCircle
                        size={14}
                        className="text-gray-400 dark:text-gray-500 cursor-help"
                      />
                      <span className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 w-64 rounded bg-gray-900 px-2 py-1 text-xs font-normal text-white opacity-0 shadow-lg transition-opacity group-hover/tt:opacity-100 dark:bg-gray-700">
                        {t('tooltipProject')}
                      </span>
                    </span>
                  </label>
                  {loadingProjects ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      <IconLoader2 size={14} className="animate-spin" />
                      {t('loadingProjects')}
                    </div>
                  ) : projects.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 py-1.5">
                      {t('noProjectsFound')}
                    </p>
                  ) : (
                    <select
                      value={projectName}
                      onChange={(e) => {
                        const proj = e.target.value;
                        setProjectName(proj);
                        setValidationResult(null);
                        if (!nameEdited && proj && proj !== 'default') {
                          setName(proj);
                        }
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
            disabled={isValidating}
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
                {existingSource ? t('save') : t('connect')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
