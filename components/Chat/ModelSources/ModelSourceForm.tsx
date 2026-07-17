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

import type { FoundryResourceTree } from '@/lib/services/agents/ResourceTreeService';

import { stripToAccountPath } from '@/lib/utils/shared/armPath';

import { OpenAIModel } from '@/types/openai';

import { AccountSelection, AccountTreePicker } from './AccountTreePicker';
import { ModelSelectionList, deploymentNameOf } from './ModelSelectionList';

import { ModelSource, useSettingsStore } from '@/client/stores/settingsStore';

interface ModelSourceFormProps {
  onSave: (source: ModelSource) => void;
  onClose: () => void;
  existingSource?: ModelSource;
}

/** Per-source entry from GET /api/models/sources. */
interface DiscoveredSourceEntry {
  path: string;
  models?: OpenAIModel[];
  error?: string;
}

function parseResourcePath(path: string) {
  // Model sources are ACCOUNT-scoped; a legacy project-suffixed path still
  // parses (the projects segment is simply ignored).
  const match = path.match(
    /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/[^/]+\/[^/]+\/([^/]+)/,
  );
  if (!match) return null;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    accountName: match[3],
  };
}

/**
 * Two-step portal modal for connecting a BYO Foundry model source. Step 1:
 * name + account location (browse the user's own Azure resources, or manual
 * entry). Step 2: pick which discovered model deployments to show, plus the
 * auto-add policy. Mirrors AgentSourceForm at the ACCOUNT level.
 */
export const ModelSourceForm: FC<ModelSourceFormProps> = ({
  onSave,
  onClose,
  existingSource,
}) => {
  const t = useTranslations('modelSources');
  // Same rollout flag as agent-source discovery: when off, hide the "browse
  // Azure resources" affordance and require manual entry. Fail-open (unset ⇒
  // enabled), mirroring AgentSourceForm.
  const { agentSourceBrowse } = useFlags();
  const isBrowseEnabled = agentSourceBrowse !== false;
  const customModelSources = useSettingsStore((s) => s.customModelSources);
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
    modelCount: number;
  } | null>(null);

  const existing = existingSource
    ? parseResourcePath(existingSource.resourcePath)
    : null;

  const [inputMode, setInputMode] = useState<'browse' | 'manual'>(
    isBrowseEnabled ? 'browse' : 'manual',
  );

  // Two-step flow: pick/enter the account, then choose which of its model
  // deployments to include (plus the auto-add policy for future deployments).
  const [step, setStep] = useState<1 | 2>(1);
  const [discoveredModels, setDiscoveredModels] = useState<OpenAIModel[]>([]);
  const [checkedNames, setCheckedNames] = useState<Set<string>>(new Set());
  const [autoAdd, setAutoAdd] = useState(
    existingSource?.autoAddNewModels ?? true,
  );
  // Tracks which path the checkbox state was seeded for, so going Back and
  // Next again doesn't clobber the user's step-2 edits.
  const seededPathRef = useRef<string | null>(null);

  // Server-built, pruned resource tree (browse mode) — shared with the agent
  // source flow (accounts are one level above projects in the same tree).
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

  const handleSelectAccount = useCallback(
    (sel: AccountSelection) => {
      setSubscriptionId(sel.subscriptionId);
      setResourceGroup(sel.resourceGroup);
      setAccountName(sel.accountName);
      setValidationResult(null);
      setError('');
      setFieldErrors((prev) => ({
        ...prev,
        subscription: undefined,
        account: undefined,
      }));
      if (!nameEdited) {
        setName(sel.accountName);
      }
    },
    [nameEdited],
  );

  const selection: AccountSelection | null =
    subscriptionId && accountName
      ? { subscriptionId, resourceGroup, accountName }
      : null;

  const buildPath = () =>
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${accountName}`;

  const validateSource = async (
    path: string,
  ): Promise<OpenAIModel[] | null> => {
    setIsValidating(true);
    setError('');
    setValidationResult(null);

    try {
      const params = new URLSearchParams({ sources: path });
      const response = await fetch(`/api/models/sources?${params.toString()}`);

      if (!response.ok) {
        setError(t('connectionFailed'));
        return null;
      }

      const data = await response.json();
      const entries: DiscoveredSourceEntry[] = data.sources ?? [];
      const entry = entries.find((s) => s.path === path) ?? entries[0];
      if (!entry || entry.error) {
        setError(t('connectionFailed'));
        return null;
      }
      const models = entry.models ?? [];
      setValidationResult({ valid: true, modelCount: models.length });
      return models;
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

    // In browse mode the tree picker fills all three fields at once, so a
    // missing selection gets one clear banner instead of per-field errors.
    if (inputMode === 'browse' && (!subscriptionId || !accountName)) {
      setError(t('accountSelectionRequired'));
      return;
    }

    // resourceGroup is derived from the chosen account, so it should always be
    // present here; guard as a fallback rather than silently building a bad path.
    if (!resourceGroup) {
      setError(t('selectAllRequired'));
      return;
    }

    const finalPath = buildPath();

    // Block a second connection to the same ACCOUNT (except the source being
    // edited): duplicate sources would mint identical byom model ids, making
    // selection highlighting and per-source exclusion lists ambiguous.
    const accountPath = stripToAccountPath(finalPath);
    const duplicate = customModelSources.find(
      (s) =>
        s.id !== existingSource?.id &&
        stripToAccountPath(s.resourcePath) === accountPath,
    );
    if (duplicate) {
      setError(t('duplicateSource', { name: duplicate.name }));
      return;
    }

    const models = await validateSource(finalPath);
    if (!models) return;

    setDiscoveredModels(models);
    if (seededPathRef.current !== finalPath) {
      // Seed checkbox state: everything checked for a new connection; an
      // edited source restores its persisted selection (only meaningful when
      // the path is unchanged — a different account starts fresh).
      const names = models.map(deploymentNameOf);
      const restoring =
        existingSource && existingSource.resourcePath === finalPath;
      let seeded: string[];
      if (restoring && existingSource.autoAddNewModels === false) {
        seeded = names.filter((n) =>
          existingSource.selectedModelNames?.includes(n),
        );
      } else if (restoring) {
        seeded = names.filter(
          (n) => !existingSource.excludedModelNames?.includes(n),
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
    const fetchedNames = new Set(discoveredModels.map(deploymentNameOf));
    const unchecked = discoveredModels
      .map(deploymentNameOf)
      .filter((n) => !checkedNames.has(n));

    // Carry over persisted names that weren't in this fetch (a transient
    // discovery gap must not silently wipe intent) — but only when editing
    // the same account; a different path starts with a clean slate.
    const samePath = existingSource?.resourcePath === finalPath;
    const prevExcluded = samePath
      ? (existingSource?.excludedModelNames ?? [])
      : [];
    const prevSelected = samePath
      ? (existingSource?.selectedModelNames ?? [])
      : [];

    const source: ModelSource = {
      id: existingSource?.id || globalThis.crypto.randomUUID(),
      name: name.trim(),
      resourcePath: finalPath.trim(),
      createdAt: existingSource?.createdAt || new Date().toISOString(),
      autoAddNewModels: autoAdd,
      excludedModelNames: autoAdd
        ? [...unchecked, ...prevExcluded.filter((n) => !fetchedNames.has(n))]
        : [],
      selectedModelNames: !autoAdd
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
            {existingSource ? t('editConnection') : t('connectFoundryAccount')}
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
            : t('selectModelsDescription')}
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
              {validationResult.modelCount > 0
                ? t('connectionSuccessModels', {
                    count: validationResult.modelCount,
                  })
                : t('connectionSuccessEmpty')}
            </span>
          </div>
        )}

        {step === 1 ? (
          /* Step 1: name + account location */
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
                {t('foundryAccountLabel')}
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
              </div>
            ) : (
              /* Browse: single searchable list of discovered accounts */
              <AccountTreePicker
                tree={tree}
                loading={loadingTree}
                selection={selection}
                onSelect={handleSelectAccount}
                onRetry={() => loadTree(true)}
              />
            )}
          </div>
        ) : (
          /* Step 2: model selection + auto-add policy */
          <ModelSelectionList
            models={discoveredModels}
            checkedNames={checkedNames}
            onToggle={(deploymentName) =>
              setCheckedNames((prev) => {
                const next = new Set(prev);
                if (next.has(deploymentName)) {
                  next.delete(deploymentName);
                } else {
                  next.add(deploymentName);
                }
                return next;
              })
            }
            onSelectAll={() =>
              setCheckedNames(new Set(discoveredModels.map(deploymentNameOf)))
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
