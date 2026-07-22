'use client';

import {
  IconAlertCircle,
  IconArrowLeft,
  IconCheck,
  IconLoader2,
  IconPlus,
  IconX,
} from '@tabler/icons-react';
import { useFlags } from 'launchdarkly-react-client-sdk';
import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import type { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';
import type { FoundryResourceTree } from '@/lib/services/agents/ResourceTreeService';

import { AgentSelectionList } from './AgentSelectionList';
import { ProjectSelection, ProjectTreePicker } from './ProjectTreePicker';

import { AgentSource } from '@/client/stores/settingsStore';

interface AgentSourceFormProps {
  onSave: (source: AgentSource) => void;
  onClose: () => void;
  existingSource?: AgentSource;
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

  // Two-step flow: pick/enter the project, then choose which of its agents
  // to include (plus the auto-add policy for future remote agents).
  const [step, setStep] = useState<1 | 2>(1);
  const [discoveredAgents, setDiscoveredAgents] = useState<DiscoveredAgent[]>(
    [],
  );
  const [checkedNames, setCheckedNames] = useState<Set<string>>(new Set());
  const [autoAdd, setAutoAdd] = useState(
    existingSource?.autoAddNewAgents ?? true,
  );
  // Tracks which path the checkbox state was seeded for, so going Back and
  // Next again doesn't clobber the user's step-2 edits.
  const seededPathRef = useRef<string | null>(null);

  // Server-built, pruned resource tree (browse mode).
  const [tree, setTree] = useState<FoundryResourceTree | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);

  // Selected values (shared between browse and manual modes)
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

  const loadTree = useCallback(async (refresh = false) => {
    setLoadingTree(true);
    try {
      const response = await fetch(
        `/api/agents/browse?level=tree${refresh ? '&refresh=1' : ''}`,
      );
      const data = await response.json();
      setTree({
        subscriptions: data.subscriptions || [],
        failedSubscriptions: data.failedSubscriptions || [],
        truncated: !!data.truncated,
      });
    } catch {
      setTree({ subscriptions: [], failedSubscriptions: [], truncated: false });
    } finally {
      setLoadingTree(false);
    }
  }, []);

  // Load the full pruned tree once when browse mode is active.
  useEffect(() => {
    if (!mounted || !isBrowseEnabled || inputMode !== 'browse') return;
    if (tree || loadingTree) return;
    loadTree();
  }, [mounted, isBrowseEnabled, inputMode, tree, loadingTree, loadTree]);

  const handleSelectProject = useCallback(
    (sel: ProjectSelection) => {
      setSubscriptionId(sel.subscriptionId);
      setResourceGroup(sel.resourceGroup);
      setAccountName(sel.accountName);
      setProjectName(sel.projectName || 'default');
      setValidationResult(null);
      setError('');
      setFieldErrors((prev) => ({
        ...prev,
        subscription: undefined,
        account: undefined,
      }));
      if (!nameEdited) {
        setName(
          sel.projectName && sel.projectName !== 'default'
            ? sel.projectName
            : sel.accountName,
        );
      }
    },
    [nameEdited],
  );

  const selection: ProjectSelection | null =
    subscriptionId && accountName
      ? { subscriptionId, resourceGroup, accountName, projectName }
      : null;

  const buildPath = () =>
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${accountName}/projects/${projectName || 'default'}`;

  const validateSource = async (
    path: string,
  ): Promise<DiscoveredAgent[] | null> => {
    setIsValidating(true);
    setError('');
    setValidationResult(null);

    try {
      const params = new URLSearchParams({ sources: path });
      const response = await fetch(`/api/agents?${params.toString()}`);

      if (!response.ok) {
        setError(t('connectionFailed'));
        return null;
      }

      const data = await response.json();
      // /api/agents merges every discovery bucket (regional/office paths and
      // admin prompt agents) into one array; only entries tagged with the
      // validated path belong to THIS connection. In particular, prompt
      // agents (type 'prompt', source 'prompt-agent') are app-defined
      // personas, not connectable Foundry resources — without this filter
      // they'd inflate agentCount and leak into the step-2 checkbox list.
      const agents: DiscoveredAgent[] = (
        (data.agents ?? []) as DiscoveredAgent[]
      ).filter((a) => a.source === path);
      setValidationResult({ valid: true, agentCount: agents.length });
      return agents;
    } catch {
      setError(t('connectionFailed'));
      return null;
    } finally {
      setIsValidating(false);
    }
  };

  const handleNext = async () => {
    setError('');

    // Surface every missing required field at once, inline, so the user always
    // learns what's blocking submission instead of facing a dead disabled button.
    const errors: typeof fieldErrors = {};
    if (!name.trim()) errors.name = t('nameRequired');
    if (inputMode === 'manual') {
      if (!subscriptionId) errors.subscription = t('subscriptionRequired');
      if (!accountName) errors.account = t('accountRequired');
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

    // In browse mode the tree picker fills all four fields at once, so a
    // missing selection gets one clear banner instead of per-field errors.
    if (inputMode === 'browse' && (!subscriptionId || !accountName)) {
      setError(t('projectSelectionRequired'));
      return;
    }

    // resourceGroup is derived from the chosen account, so it should always be
    // present here; guard as a fallback rather than silently building a bad path.
    if (!resourceGroup) {
      setError(t('selectAllRequired'));
      return;
    }

    const finalPath = buildPath();
    const agents = await validateSource(finalPath);
    if (!agents) return;

    setDiscoveredAgents(agents);
    if (seededPathRef.current !== finalPath) {
      // Seed checkbox state: everything checked for a new connection; an
      // edited source restores its persisted selection (only meaningful when
      // the path is unchanged — a different project starts fresh).
      const names = agents.map((a) => a.agentName);
      const restoring =
        existingSource && existingSource.resourcePath === finalPath;
      let seeded: string[];
      if (restoring && existingSource.autoAddNewAgents === false) {
        seeded = names.filter((n) =>
          existingSource.selectedAgentNames?.includes(n),
        );
      } else if (restoring) {
        seeded = names.filter(
          (n) => !existingSource.excludedAgentNames?.includes(n),
        );
      } else {
        seeded = names;
      }
      setCheckedNames(new Set(seeded));
      seededPathRef.current = finalPath;
    }
    setStep(2);
  };

  const handleSave = () => {
    const finalPath = buildPath();
    const fetchedNames = new Set(discoveredAgents.map((a) => a.agentName));
    const unchecked = discoveredAgents
      .filter((a) => !checkedNames.has(a.agentName))
      .map((a) => a.agentName);

    // Carry over persisted names that weren't in this fetch (a transient
    // discovery gap must not silently wipe intent) — but only when editing
    // the same project; a different path starts with a clean slate.
    const samePath = existingSource?.resourcePath === finalPath;
    const prevExcluded = samePath
      ? (existingSource?.excludedAgentNames ?? [])
      : [];
    const prevSelected = samePath
      ? (existingSource?.selectedAgentNames ?? [])
      : [];

    const source: AgentSource = {
      id: existingSource?.id || globalThis.crypto.randomUUID(),
      name: name.trim(),
      resourcePath: finalPath.trim(),
      createdAt: existingSource?.createdAt || new Date().toISOString(),
      autoAddNewAgents: autoAdd,
      excludedAgentNames: autoAdd
        ? [...unchecked, ...prevExcluded.filter((n) => !fetchedNames.has(n))]
        : [],
      selectedAgentNames: !autoAdd
        ? [...checkedNames, ...prevSelected.filter((n) => !fetchedNames.has(n))]
        : [],
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
          {step === 1
            ? t('connectFoundryDescription')
            : t('selectAgentsDescription')}
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

        {step === 1 ? (
          /* Step 1: name + project location */
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
              /* Browse: single searchable list of discovered projects */
              <ProjectTreePicker
                tree={tree}
                loading={loadingTree}
                selection={selection}
                onSelect={handleSelectProject}
                onRetry={() => loadTree(true)}
              />
            )}
          </div>
        ) : (
          /* Step 2: agent selection + auto-add policy */
          <AgentSelectionList
            agents={discoveredAgents}
            checkedNames={checkedNames}
            onToggle={(agentName) =>
              setCheckedNames((prev) => {
                const next = new Set(prev);
                if (next.has(agentName)) {
                  next.delete(agentName);
                } else {
                  next.add(agentName);
                }
                return next;
              })
            }
            onSelectAll={() =>
              setCheckedNames(new Set(discoveredAgents.map((a) => a.agentName)))
            }
            onDeselectAll={() => setCheckedNames(new Set())}
            autoAdd={autoAdd}
            onAutoAddChange={setAutoAdd}
          />
        )}

        {/* Actions */}
        <div className="mt-6 flex justify-end gap-2">
          {step === 1 ? (
            <>
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleNext}
                disabled={isValidating}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isValidating ? (
                  <>
                    <IconLoader2 size={16} className="animate-spin" />
                    {t('checkingConnection')}
                  </>
                ) : (
                  t('next')
                )}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep(1)}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <IconArrowLeft size={16} />
                {t('back')}
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
              >
                <IconPlus size={16} />
                {existingSource ? t('save') : t('connect')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
};
