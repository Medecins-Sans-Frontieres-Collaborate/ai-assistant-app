'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  WebSearchConfigConflict,
  WebSearchConfigResponse,
  useWebSearchConfigAdmin,
} from '@/client/hooks/settings/useWebSearchConfigAdmin';

import {
  MULTI_STEP_DEFAULTS,
  MultiStepSettings,
  ResolvedMultiStepConfig,
  resolveMultiStepConfig,
} from '@/lib/services/webSearch/config/types';

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
  ADMIN_LABEL,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';

type NumericKey =
  | 'maxSteps'
  | 'maxStepsExploratory'
  | 'maxPageReadsPerStep'
  | 'timeBudgetSeconds';
type BooleanKey = 'enabled' | 'pageReads' | 'sourceAssessment';

/**
 * Only the values that differ from the code defaults are stored: a setting
 * left at its default keeps following that default across releases, and
 * "Reset to defaults" is simply an empty document.
 */
function overridesOf(
  draft: ResolvedMultiStepConfig,
  defaults: ResolvedMultiStepConfig,
): MultiStepSettings {
  const overrides: Record<string, unknown> = {};
  for (const key of Object.keys(defaults) as Array<
    keyof ResolvedMultiStepConfig
  >) {
    if (draft[key] !== defaults[key]) overrides[key] = draft[key];
  }
  return overrides as MultiStepSettings;
}

/**
 * Admin panel for the web search configuration
 * (docs/WEB_SEARCH_MULTI_STEP.md).
 *
 * One document, one CAS'd PUT with If-Match; on 409 the admin is told
 * another admin won the race and the settings are reloaded. The server
 * component gates access; this client is presentation only. Defaults,
 * bounds and the assessor choices all come from the API, so nothing here
 * can drift from what the server enforces.
 */
export const WebSearchConfigPanel: FC = () => {
  const t = useTranslations('webSearchAdmin');
  const { query, save } = useWebSearchConfigAdmin();
  const [draft, setDraft] = useState<ResolvedMultiStepConfig>({
    ...MULTI_STEP_DEFAULTS,
  });
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Seed the draft from each NEW server response during render (the
  // "storing information from previous renders" pattern) rather than in an
  // effect, so a reload after a 409 replaces the stale draft in the same
  // pass and never flashes the old values.
  const [seededFrom, setSeededFrom] = useState<WebSearchConfigResponse | null>(
    null,
  );
  if (
    query.data &&
    query.data !== seededFrom &&
    !query.data.configUnavailable
  ) {
    const { assessorModels } = query.data;
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setDraft(
      resolveMultiStepConfig(query.data.config, (id) =>
        assessorModels.some((model) => model.id === id),
      ),
    );
    setDirty(false);
  }

  const update = (patch: Partial<ResolvedMultiStepConfig>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
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

  if (query.data.configUnavailable) {
    return (
      <div className="p-6">
        <div className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}>
          <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">{t('configUnavailable')}</span>
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

  const { config, defaults, bounds, assessorModels, assessorFallbackModelId } =
    query.data;
  const modelName = (id: string) =>
    assessorModels.find((model) => model.id === id)?.name ?? id;

  const clamp = (key: NumericKey, value: number): number => {
    const { min, max } = bounds[key];
    if (!Number.isFinite(value)) return defaults[key];
    return Math.min(max, Math.max(min, Math.round(value)));
  };

  const handleSave = async () => {
    // Inputs are clamped as typed; the one cross-field rule is applied here
    // so the saved document is always one the server accepts.
    const maxSteps = clamp('maxSteps', draft.maxSteps);
    const normalized: ResolvedMultiStepConfig = {
      ...draft,
      maxSteps,
      maxStepsExploratory: Math.max(
        maxSteps,
        clamp('maxStepsExploratory', draft.maxStepsExploratory),
      ),
      maxPageReadsPerStep: clamp(
        'maxPageReadsPerStep',
        draft.maxPageReadsPerStep,
      ),
      timeBudgetSeconds: clamp('timeBudgetSeconds', draft.timeBudgetSeconds),
    };
    try {
      const result = await save.mutateAsync({
        multiStep: overridesOf(normalized, defaults),
        etag,
      });
      setEtag(result.etag);
      setDraft(normalized);
      setDirty(false);
      toast.success(t('saveSuccess'));
    } catch (error) {
      if (error instanceof WebSearchConfigConflict) {
        toast.error(t('conflictError'));
        await query.refetch();
        return;
      }
      toast.error(t('saveError'));
    }
  };

  const toggleRow = (
    key: BooleanKey,
    labelKey: string,
    descriptionKey: string,
  ) => {
    const inputId = `web-search-${key}`;
    return (
      <li className={`${ADMIN_ROW} flex items-start gap-3`}>
        <input
          id={inputId}
          type="checkbox"
          className={`${ADMIN_CHECKBOX} mt-1`}
          checked={draft[key]}
          disabled={key !== 'enabled' && !draft.enabled}
          onChange={(e) => update({ [key]: e.target.checked })}
        />
        <label htmlFor={inputId} className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-black dark:text-white">
            {t(labelKey)}
          </span>
          <span className={`block ${ADMIN_MUTED}`}>{t(descriptionKey)}</span>
          <span className={`block ${ADMIN_HINT}`}>
            {t('defaultHint', {
              value: defaults[key] ? t('defaultOn') : t('defaultOff'),
            })}
          </span>
        </label>
      </li>
    );
  };

  const numberRow = (
    key: NumericKey,
    labelKey: string,
    descriptionKey: string | null,
    disabled: boolean,
  ) => {
    const inputId = `web-search-${key}`;
    const { min, max } = bounds[key];
    return (
      <li className={ADMIN_ROW}>
        <label htmlFor={inputId} className={ADMIN_LABEL}>
          {t(labelKey)}
        </label>
        <div className="flex items-center gap-3">
          <input
            id={inputId}
            type="number"
            className={`${ADMIN_FIELD} w-24`}
            min={min}
            max={max}
            step={1}
            value={draft[key]}
            disabled={disabled}
            onChange={(e) =>
              update({ [key]: clamp(key, e.target.valueAsNumber) })
            }
          />
          <span className={ADMIN_MUTED}>{t('rangeHint', { min, max })}</span>
        </div>
        {descriptionKey && <p className={ADMIN_HINT}>{t(descriptionKey)}</p>}
        <p className={ADMIN_HINT}>
          {t('defaultHint', { value: defaults[key] })}
        </p>
      </li>
    );
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <h2 className="text-lg font-semibold text-black dark:text-white">
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
          {t('description')}
        </p>
        <p className={ADMIN_HINT}>{t('scopeNote')}</p>
      </header>

      <section className={ADMIN_CARD}>
        <ul className="space-y-2">
          {toggleRow('enabled', 'enabledLabel', 'enabledDescription')}

          <li className={ADMIN_ROW}>
            <label htmlFor="web-search-assessor" className={ADMIN_LABEL}>
              {t('assessorLabel')}
            </label>
            <select
              id="web-search-assessor"
              className={ADMIN_FIELD}
              value={draft.assessorModelId}
              disabled={!draft.enabled}
              onChange={(e) => update({ assessorModelId: e.target.value })}
            >
              {assessorModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            <p className={ADMIN_HINT}>
              {t('assessorDescription', {
                fallback: modelName(assessorFallbackModelId),
              })}
            </p>
            <p className={ADMIN_HINT}>
              {t('defaultHint', { value: modelName(defaults.assessorModelId) })}
            </p>
          </li>

          {numberRow(
            'maxSteps',
            'maxStepsLabel',
            'maxStepsDescription',
            !draft.enabled,
          )}
          {numberRow(
            'maxStepsExploratory',
            'maxStepsExploratoryLabel',
            'maxStepsExploratoryDescription',
            !draft.enabled,
          )}
          {toggleRow('pageReads', 'pageReadsLabel', 'pageReadsDescription')}
          {numberRow(
            'maxPageReadsPerStep',
            'maxPageReadsLabel',
            null,
            !draft.enabled || !draft.pageReads,
          )}
          {toggleRow(
            'sourceAssessment',
            'sourceAssessmentLabel',
            'sourceAssessmentDescription',
          )}
          {numberRow(
            'timeBudgetSeconds',
            'timeBudgetLabel',
            'timeBudgetDescription',
            !draft.enabled,
          )}
        </ul>
        <p className={ADMIN_HINT}>{t('defaultsNote')}</p>
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
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          disabled={save.isPending}
          onClick={() => update({ ...defaults })}
        >
          {t('resetDefaults')}
        </button>
        {dirty && <span className={ADMIN_MUTED}>{t('unsaved')}</span>}
        {!dirty && (
          <span className={ADMIN_MUTED}>
            {config
              ? t('updatedByLine', {
                  by: config.updatedBy,
                  at: new Date(config.updatedAt).toLocaleString(),
                })
              : t('neverSaved')}
          </span>
        )}
      </footer>
    </div>
  );
};
