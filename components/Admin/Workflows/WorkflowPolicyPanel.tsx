'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  WorkflowPolicyConflict,
  WorkflowPolicyResponse,
  useWorkflowPolicyAdmin,
} from '@/client/hooks/settings/useWorkflowPolicyAdmin';

import {
  MAX_FEATURE_OVERRIDES,
  WORKFLOW_FEATURES,
  WORKFLOW_FEATURE_IDS,
  WORKFLOW_FEATURE_OVERRIDE_SCOPES,
  WORKFLOW_POLICY_DEFAULTS,
  WorkflowFeatureId,
  WorkflowFeatureOverrideScope,
  WorkflowFeatureSetting,
  WorkflowPolicy,
  featureSettingProblem,
  resolveAllWorkflowsEnabled,
  resolveWorkflowFeatureLimits,
  resolveWorkflowFeatureSetting,
  workflowFeaturesOf,
} from '@/lib/services/workflows/policy/types';

import {
  CONVERSATION_WORKFLOW_TYPES,
  ConversationWorkflowType,
} from '@/types/workflow';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';
import { WORKFLOW_META } from '@/components/Workflows/registryMeta';

type Draft = Record<ConversationWorkflowType, boolean>;
type FeatureDraft = Record<WorkflowFeatureId, boolean>;

/**
 * A feature's limits as typed. Numbers are kept as text while editing so a
 * field can be cleared; in an override an empty field means "inherit".
 */
interface OverrideDraft {
  scope: WorkflowFeatureOverrideScope;
  /** Comma-separated, as typed. */
  targets: string;
  limits: Record<string, string>;
}
interface LimitsDraft {
  limits: Record<string, string>;
  overrides: OverrideDraft[];
}
type LimitsDrafts = Record<WorkflowFeatureId, LimitsDraft>;

/** Every feature's limits and overrides under a (possibly absent) policy. */
function limitsDraftsFrom(policy: WorkflowPolicy | null): LimitsDrafts {
  const drafts = {} as LimitsDrafts;
  const asText = (limits: Record<string, number>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(limits).map(([key, value]) => [key, String(value)]),
    );
  for (const id of WORKFLOW_FEATURE_IDS) {
    drafts[id] = {
      limits: asText(resolveWorkflowFeatureLimits(policy, id)),
      overrides: (policy?.features?.[id]?.overrides ?? []).map((override) => ({
        scope: override.scope,
        targets: override.targets.join(', '),
        limits: asText(override.limits),
      })),
    };
  }
  return drafts;
}

/** Typed limits as numbers; fields left empty are left out. */
function numbersFrom(limits: Record<string, string>): Record<string, number> {
  const numbers: Record<string, number> = {};
  for (const [key, text] of Object.entries(limits)) {
    if (text.trim()) numbers[key] = Number(text);
  }
  return numbers;
}

/** The setting to save for one feature; overrides naming nobody are dropped. */
function featureSettingFrom(
  enabled: boolean,
  draft: LimitsDraft,
): WorkflowFeatureSetting {
  const overrides = draft.overrides
    .map((override) => ({
      scope: override.scope,
      targets: override.targets
        .split(',')
        .map((target) => target.trim())
        .filter(Boolean),
      limits: numbersFrom(override.limits),
    }))
    .filter((override) => override.targets.length > 0);
  return {
    enabled,
    limits: numbersFrom(draft.limits),
    ...(overrides.length > 0 ? { overrides } : {}),
  };
}

/** Each feature's own switch under a (possibly absent) saved policy. */
function featureDraftFrom(policy: WorkflowPolicy | null): FeatureDraft {
  const draft = {} as FeatureDraft;
  for (const id of WORKFLOW_FEATURE_IDS) {
    draft[id] = resolveWorkflowFeatureSetting(policy, id);
  }
  return draft;
}

/**
 * Admin panel for the workflow enable/disable policy
 * (docs/ADMIN_WORKFLOWS_AND_VIEW_AS.md).
 *
 * Each workflow row lists its optional features (WORKFLOW_FEATURES)
 * underneath; a feature's switch is kept but has no effect while its
 * workflow is off, so it is shown disabled then.
 *
 * One document, one CAS'd PUT with If-Match; on 409 the admin is told
 * another admin won the race and the policy is reloaded. The server
 * component gates access; this client is presentation only.
 */
export const WorkflowPolicyPanel: FC = () => {
  const t = useTranslations('workflowsAdmin');
  const tWorkflows = useTranslations('workflows');
  const { query, save } = useWorkflowPolicyAdmin();
  const [draft, setDraft] = useState<Draft>({ ...WORKFLOW_POLICY_DEFAULTS });
  const [featureDraft, setFeatureDraft] = useState<FeatureDraft>(() =>
    featureDraftFrom(null),
  );
  const [limitsDrafts, setLimitsDrafts] = useState<LimitsDrafts>(() =>
    limitsDraftsFrom(null),
  );
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Seed the draft from each NEW server response during render (the
  // "storing information from previous renders" pattern) rather than in an
  // effect, so a reload after a 409 replaces the stale draft in the same
  // pass and never flashes the old toggles.
  const [seededFrom, setSeededFrom] = useState<WorkflowPolicyResponse | null>(
    null,
  );
  if (
    query.data &&
    query.data !== seededFrom &&
    !query.data.policyUnavailable
  ) {
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setDraft(resolveAllWorkflowsEnabled(query.data.policy));
    setFeatureDraft(featureDraftFrom(query.data.policy));
    setLimitsDrafts(limitsDraftsFrom(query.data.policy));
    setDirty(false);
  }

  const setAll = (enabled: boolean) => {
    const next = {} as Draft;
    for (const type of CONVERSATION_WORKFLOW_TYPES) next[type] = enabled;
    const nextFeatures = {} as FeatureDraft;
    for (const id of WORKFLOW_FEATURE_IDS) nextFeatures[id] = enabled;
    setDraft(next);
    setFeatureDraft(nextFeatures);
    setDirty(true);
  };

  const editLimits = (
    id: WorkflowFeatureId,
    update: (draft: LimitsDraft) => LimitsDraft,
  ) => {
    setLimitsDrafts((prev) => ({ ...prev, [id]: update(prev[id]) }));
    setDirty(true);
  };
  const editOverride = (
    id: WorkflowFeatureId,
    index: number,
    update: (override: OverrideDraft) => OverrideDraft,
  ) =>
    editLimits(id, (draft) => ({
      ...draft,
      overrides: draft.overrides.map((override, at) =>
        at === index ? update(override) : override,
      ),
    }));

  const toggleFeature = (id: WorkflowFeatureId) => {
    setFeatureDraft((prev) => ({ ...prev, [id]: !prev[id] }));
    setDirty(true);
  };

  const toggle = (type: ConversationWorkflowType) => {
    setDraft((prev) => ({ ...prev, [type]: !prev[type] }));
    setDirty(true);
  };

  const handleSave = async () => {
    const workflows = {} as Record<
      ConversationWorkflowType,
      { enabled: boolean }
    >;
    for (const type of CONVERSATION_WORKFLOW_TYPES) {
      workflows[type] = { enabled: draft[type] };
    }
    const features = {} as Record<WorkflowFeatureId, WorkflowFeatureSetting>;
    for (const id of WORKFLOW_FEATURE_IDS) {
      features[id] = featureSettingFrom(featureDraft[id], limitsDrafts[id]);
      // The server refuses the same things; saying so here keeps the
      // admin's other unsaved changes on the page.
      if (featureSettingProblem(id, features[id])) {
        toast.error(t('limitsInvalid'));
        return;
      }
    }
    try {
      const result = await save.mutateAsync({ workflows, features, etag });
      setEtag(result.etag);
      setDirty(false);
      toast.success(t('saveSuccess'));
    } catch (error) {
      if (error instanceof WorkflowPolicyConflict) {
        toast.error(t('conflictError'));
        await query.refetch();
        return;
      }
      toast.error(t('saveError'));
    }
  };

  /** The limit fields and overrides of one feature, when it has limits. */
  const renderLimits = (id: WorkflowFeatureId, active: boolean) => {
    const definitions = Object.entries(WORKFLOW_FEATURES[id].limits ?? {});
    if (definitions.length === 0) return null;
    const draftOf = limitsDrafts[id];
    const field = (
      key: string,
      value: string,
      onChange: (text: string) => void,
      inherit?: string,
    ) => {
      const definition = WORKFLOW_FEATURES[id].limits?.[key];
      return (
        <label key={key} className="flex min-w-[9rem] flex-1 flex-col gap-1">
          <span className="text-xs text-gray-700 dark:text-gray-300">
            {t(`features.${id}.limits.${key}`)}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={definition?.min}
            max={definition?.max}
            value={value}
            placeholder={inherit}
            onChange={(event) => onChange(event.target.value)}
            className={`${ADMIN_FIELD} w-full`}
          />
          <span className={ADMIN_HINT}>
            {t('limitRange', {
              min: definition?.min ?? 0,
              max: definition?.max ?? 0,
            })}
          </span>
        </label>
      );
    };
    return (
      <fieldset
        disabled={!active}
        className={`basis-full space-y-3 ps-7 ${active ? '' : 'opacity-60'}`}
      >
        <legend className="sr-only">{t('limitsTitle')}</legend>
        <div className="flex flex-wrap gap-3">
          {definitions.map(([key]) =>
            field(key, draftOf.limits[key] ?? '', (text) =>
              editLimits(id, (current) => ({
                ...current,
                limits: { ...current.limits, [key]: text },
              })),
            ),
          )}
        </div>
        <p className={ADMIN_HINT}>{t(`features.${id}.limitsNote`)}</p>

        <div className="space-y-2">
          <h4 className="text-sm font-medium text-black dark:text-white">
            {t('overridesTitle')}
          </h4>
          <p className={ADMIN_HINT}>{t('overridesNote')}</p>
          {draftOf.overrides.map((override, index) => (
            <div
              key={index}
              className={`${ADMIN_ROW} space-y-2`}
              data-testid={`feature-override-${id}-${index}`}
            >
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-gray-700 dark:text-gray-300">
                    {t('overrideScope')}
                  </span>
                  <select
                    value={override.scope}
                    onChange={(event) =>
                      editOverride(id, index, (current) => ({
                        ...current,
                        scope: event.target
                          .value as WorkflowFeatureOverrideScope,
                      }))
                    }
                    className={ADMIN_FIELD}
                  >
                    {WORKFLOW_FEATURE_OVERRIDE_SCOPES.map((scope) => (
                      <option key={scope} value={scope}>
                        {t(`overrideScopes.${scope}.label`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
                  <span className="text-xs text-gray-700 dark:text-gray-300">
                    {t('overrideTargets')}
                  </span>
                  <input
                    type="text"
                    value={override.targets}
                    placeholder={t(
                      `overrideScopes.${override.scope}.placeholder`,
                    )}
                    onChange={(event) =>
                      editOverride(id, index, (current) => ({
                        ...current,
                        targets: event.target.value,
                      }))
                    }
                    className={`${ADMIN_FIELD} w-full`}
                  />
                </label>
                <button
                  type="button"
                  className={ADMIN_BTN_SECONDARY}
                  onClick={() =>
                    editLimits(id, (current) => ({
                      ...current,
                      overrides: current.overrides.filter(
                        (_, at) => at !== index,
                      ),
                    }))
                  }
                >
                  {t('overrideRemove')}
                </button>
              </div>
              <div className="flex flex-wrap gap-3">
                {definitions.map(([key]) =>
                  field(
                    key,
                    override.limits[key] ?? '',
                    (text) =>
                      editOverride(id, index, (current) => ({
                        ...current,
                        limits: { ...current.limits, [key]: text },
                      })),
                    t('overrideInherit', { value: draftOf.limits[key] ?? '' }),
                  ),
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            disabled={draftOf.overrides.length >= MAX_FEATURE_OVERRIDES}
            onClick={() =>
              editLimits(id, (current) => ({
                ...current,
                overrides: [
                  ...current.overrides,
                  { scope: 'user', targets: '', limits: {} },
                ],
              }))
            }
          >
            {t('overrideAdd')}
          </button>
        </div>
      </fieldset>
    );
  };

  if (query.isLoading) {
    return <p className={`p-6 ${ADMIN_MUTED}`}>{t('loading')}</p>;
  }

  if (query.isError || !query.data) {
    return (
      <div className="p-6">
        <div className={`${ADMIN_BANNER_ERROR} flex items-center gap-3`}>
          <span className="flex-1">{t('loadError')}</span>
          <button
            type="button"
            className={ADMIN_BTN_RETRY}
            onClick={() => query.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  }

  if (query.data.policyUnavailable) {
    return (
      <div className="p-6">
        <div className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}>
          <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">{t('policyUnavailable')}</span>
          <button
            type="button"
            className={ADMIN_BTN_RETRY}
            onClick={() => query.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      </div>
    );
  }

  const policy = query.data.policy;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold text-black dark:text-white">
          {t('title')}
        </h2>
        <p className={`mt-1 text-sm text-gray-600 dark:text-gray-300`}>
          {t('description')}
        </p>
        <p className={ADMIN_HINT}>{t('layeredNote')}</p>
      </header>

      <section className={ADMIN_CARD}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setAll(true)}
          >
            {t('enableAll')}
          </button>
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => setAll(false)}
          >
            {t('disableAll')}
          </button>
        </div>

        <ul className="space-y-2">
          {CONVERSATION_WORKFLOW_TYPES.map((type) => {
            const meta = WORKFLOW_META[type];
            const Icon = meta.icon;
            const inputId = `workflow-policy-${type}`;
            const features = workflowFeaturesOf(type);
            return (
              <li key={type} className={ADMIN_ROW}>
                <div className="flex items-start gap-3">
                  <input
                    id={inputId}
                    type="checkbox"
                    className={`${ADMIN_CHECKBOX} mt-1`}
                    checked={draft[type]}
                    onChange={() => toggle(type)}
                  />
                  <label htmlFor={inputId} className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-black dark:text-white">
                      <Icon size={16} aria-hidden />
                      {tWorkflows(`types.${meta.i18nKey}.label`)}
                      <span className={ADMIN_MUTED}>
                        {draft[type] ? t('enabledLabel') : t('disabledLabel')}
                      </span>
                    </span>
                    <span className={`block ${ADMIN_MUTED}`}>
                      {tWorkflows(`types.${meta.i18nKey}.description`)}
                    </span>
                    <span className={`block ${ADMIN_HINT}`}>
                      {WORKFLOW_POLICY_DEFAULTS[type]
                        ? t('defaultOnHint')
                        : t('defaultOffHint')}
                    </span>
                    {type === 'grants' && (
                      <span className={`block ${ADMIN_HINT}`}>
                        {t('grantsNote')}
                      </span>
                    )}
                  </label>
                </div>
                {features.length > 0 && (
                  <ul className="ml-7 mt-3 space-y-2 border-l border-gray-200 pl-4 dark:border-gray-700">
                    {features.map((id) => {
                      const featureInputId = `workflow-feature-${id}`;
                      const on = featureDraft[id];
                      return (
                        <li
                          key={id}
                          className="flex flex-wrap items-start gap-3"
                        >
                          <input
                            id={featureInputId}
                            type="checkbox"
                            className={`${ADMIN_CHECKBOX} mt-1`}
                            checked={on}
                            disabled={!draft[type]}
                            onChange={() => toggleFeature(id)}
                          />
                          <label
                            htmlFor={featureInputId}
                            className={`min-w-0 flex-1 ${draft[type] ? '' : 'opacity-60'}`}
                          >
                            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-black dark:text-white">
                              {t(`features.${id}.label`)}
                              <span className={ADMIN_MUTED}>
                                {on ? t('enabledLabel') : t('disabledLabel')}
                              </span>
                            </span>
                            <span className={`block ${ADMIN_MUTED}`}>
                              {t(`features.${id}.description`)}
                            </span>
                            <span className={`block ${ADMIN_HINT}`}>
                              {draft[type]
                                ? WORKFLOW_FEATURES[id].defaultEnabled
                                  ? t('defaultOnHint')
                                  : t('defaultOffHint')
                                : t('featureNeedsWorkflow')}
                            </span>
                          </label>
                          {renderLimits(id, draft[type] && on)}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <footer className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={ADMIN_BTN_PRIMARY}
          disabled={!dirty || save.isPending}
          onClick={handleSave}
        >
          {save.isPending ? t('saving') : t('save')}
        </button>
        {dirty && <span className={ADMIN_MUTED}>{t('unsaved')}</span>}
        {!dirty && (
          <span className={ADMIN_MUTED}>
            {policy
              ? t('updatedByLine', {
                  by: policy.updatedBy,
                  at: new Date(policy.updatedAt).toLocaleString(),
                })
              : t('neverSaved')}
          </span>
        )}
      </footer>
    </div>
  );
};
