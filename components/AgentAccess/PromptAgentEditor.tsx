'use client';

import { FC, useId, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { isModelSelectableInRegion } from '@/lib/utils/shared/modelRegion';

import { OpenAIModels } from '@/types/openai';

import { AdminStoredPromptAgent } from './types';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Agent-backed model ids can't be a prompt agent's engine (the server
 * rejects them with a 400) — mirror of the write-side filter in
 * app/api/agent-access/prompt-agents/route.ts.
 */
const AGENT_MODEL_ID_PREFIXES = ['foundry-', 'org-', 'custom-', 'byom-'];

/**
 * Mirror of the server's validateModelId membership check: the id must exist
 * in the static OpenAIModels registry or the save 400s. Discovered
 * deployments synthesized by /api/models (SHOW_MODELS_WITHOUT_METADATA) live
 * in settingsStore but NOT in the registry, so they must not be offered.
 * hasOwnProperty (not `in`): a prototype name like 'constructor' must not
 * pass as a known model id.
 */
function isServerKnownModelId(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(OpenAIModels, modelId);
}

/**
 * The one save failure the admin can actually fix in the form is a rejected
 * modelId (validateModelId 400s with a message naming the field). Surface
 * that specifically instead of the generic "try again" — retrying without
 * changing the model can never succeed.
 */
async function classifySaveFailure(
  response: Response,
): Promise<'generic' | 'unknownModel'> {
  if (response.status !== 400) return 'generic';
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' && body.error.includes('modelId')
      ? 'unknownModel'
      : 'generic';
  } catch {
    return 'generic';
  }
}

interface PromptAgentEditorProps {
  /** null = create a new agent (POST); otherwise edit (PUT with If-Match). */
  existing: AdminStoredPromptAgent | null;
  /** Agent saved successfully — parent refetches and closes. */
  onSaved: () => void;
  onCancel: () => void;
  /** 409 conflict acknowledged — parent refetches (agent + etag) and closes. */
  onConflictReload: () => void;
}

/**
 * Inline create/edit card for one app-defined prompt agent (display name +
 * system prompt + model). Follows the RuleEditor idiom: bordered card,
 * Cancel/Save footer, 409 → conflict banner + reload. The parent remounts
 * it via a `${id}:${etag}` key so state reseeds after a conflict reload.
 */
export const PromptAgentEditor: FC<PromptAgentEditorProps> = ({
  existing,
  onSaved,
  onCancel,
  onConflictReload,
}) => {
  const t = useTranslations('agentAccess');

  const models = useSettingsStore((s) => s.models);
  const userRegion = useSettingsStore((s) => s.userRegion);

  const [name, setName] = useState(existing?.agent.name ?? '');
  const [description, setDescription] = useState(
    existing?.agent.description ?? '',
  );
  const [systemPrompt, setSystemPrompt] = useState(
    existing?.agent.systemPrompt ?? '',
  );
  const [modelId, setModelId] = useState(existing?.agent.modelId ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [isConflict, setIsConflict] = useState(false);
  const [saveError, setSaveError] = useState<'generic' | 'unknownModel' | null>(
    null,
  );
  const baseId = useId();

  const selectableModels = useMemo(
    () =>
      models.filter(
        (m) =>
          !AGENT_MODEL_ID_PREFIXES.some((prefix) => m.id.startsWith(prefix)) &&
          isServerKnownModelId(m.id) &&
          isModelSelectableInRegion(m, userRegion),
      ),
    [models, userRegion],
  );
  // A stored modelId can fall outside the current list (model retired, or
  // region-filtered for this admin) — keep it selectable so opening the
  // editor doesn't silently clear the agent's engine. When the id is gone
  // from the OpenAIModels registry the server will reject it, so label it
  // unavailable to point the admin at the actual fix (pick another model).
  const storedModelMissing =
    modelId !== '' && !selectableModels.some((m) => m.id === modelId);
  const storedModelUnknown =
    storedModelMissing && !isServerKnownModelId(modelId);

  const canSave =
    name.trim().length > 0 && systemPrompt.trim().length > 0 && modelId !== '';

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/agent-access/prompt-agents', {
        method: existing ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Updates carry the CAS etag; creates are create-only server-side.
          ...(existing ? { 'If-Match': existing.etag } : {}),
        },
        body: JSON.stringify({
          ...(existing ? { id: existing.agent.id } : {}),
          name: name.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          modelId,
        }),
      });
      if (response.status === 409) {
        setIsConflict(true);
        return;
      }
      // Update path 404 = the agent was deleted while this editor was open.
      // Same situation as a CAS conflict (a PUT can never mint a new record,
      // so retrying is a dead end) — route it to the conflict banner whose
      // Reload refetches the list and drops the stale row.
      if (existing && response.status === 404) {
        setIsConflict(true);
        return;
      }
      if (!response.ok) {
        setSaveError(await classifySaveFailure(response));
        return;
      }
      toast.success(
        t(existing ? 'promptAgentSaveSuccess' : 'promptAgentCreateSuccess'),
      );
      onSaved();
    } catch {
      setSaveError('generic');
    } finally {
      setIsSaving(false);
    }
  };

  const inputClass =
    'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500';

  return (
    <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-4">
      <p className="mb-3 text-sm font-semibold text-black dark:text-white">
        {existing ? t('editPromptAgentTitle') : t('newPromptAgentTitle')}
      </p>

      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-black dark:text-white">
            {t('agentNameLabel')}
          </label>
          <input
            type="text"
            className={inputClass}
            value={name}
            placeholder={t('agentNamePlaceholder')}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-black dark:text-white">
            {t('agentDescriptionLabel')}
          </label>
          <input
            type="text"
            className={inputClass}
            value={description}
            placeholder={t('agentDescriptionPlaceholder')}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-black dark:text-white">
            {t('agentSystemPromptLabel')}
          </label>
          <textarea
            className={inputClass}
            rows={6}
            value={systemPrompt}
            placeholder={t('agentSystemPromptPlaceholder')}
            maxLength={10000}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-black dark:text-white">
            {t('agentModelLabel')}
          </label>
          <select
            className={inputClass}
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            <option value="" disabled>
              {t('agentModelPlaceholder')}
            </option>
            {storedModelMissing && <option value={modelId}>{modelId}</option>}
            {selectableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isConflict && (
        <div className="mt-4 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
          <p>{t('conflictError')}</p>
          <button
            type="button"
            className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700"
            onClick={onConflictReload}
          >
            {t('reload')}
          </button>
        </div>
      )}

      {saveError && !isConflict && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          {t('saveError')}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-200 dark:text-gray-300 dark:hover:bg-gray-700"
          onClick={onCancel}
          disabled={isSaving}
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          onClick={handleSave}
          disabled={isSaving || isConflict || !canSave}
        >
          {isSaving ? t('saving') : t('save')}
        </button>
      </div>
    </div>
  );
};
