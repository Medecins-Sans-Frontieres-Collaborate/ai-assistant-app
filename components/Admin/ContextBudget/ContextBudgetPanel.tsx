'use client';

import { IconAlertTriangle, IconX } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  ContextBudgetConfigConflict,
  ContextBudgetConfigResponse,
  useContextBudgetAdmin,
} from '@/client/hooks/settings/useContextBudgetAdmin';

import {
  CONTEXT_BUDGET_DEFAULTS,
  ContextBudgetSettings,
  ResolvedContextBudgetConfig,
  resolveContextBudgetConfig,
  resolveHistoryBudget,
} from '@/lib/services/contextBudget/types';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';

type NumericKey = 'historyTokens' | 'historyFraction' | 'minRecentMessages';
type OverrideKey = 'familyOverrides' | 'modelOverrides';

const sameMap = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([key, value]) => b[key] === value);

/**
 * Only the values that differ from the code defaults are stored: a setting
 * left at its default keeps following that default across releases, and
 * "Reset to defaults" is simply an empty document.
 */
function overridesOf(
  draft: ResolvedContextBudgetConfig,
  defaults: ResolvedContextBudgetConfig,
): ContextBudgetSettings {
  const overrides: ContextBudgetSettings = {};
  if (draft.historyTokens !== defaults.historyTokens) {
    overrides.historyTokens = draft.historyTokens;
  }
  if (draft.historyFraction !== defaults.historyFraction) {
    overrides.historyFraction = draft.historyFraction;
  }
  if (draft.minRecentMessages !== defaults.minRecentMessages) {
    overrides.minRecentMessages = draft.minRecentMessages;
  }
  if (!sameMap(draft.familyOverrides, defaults.familyOverrides)) {
    overrides.familyOverrides = draft.familyOverrides;
  }
  if (!sameMap(draft.modelOverrides, defaults.modelOverrides)) {
    overrides.modelOverrides = draft.modelOverrides;
  }
  return overrides;
}

const formatTokens = (n: number) => n.toLocaleString();

/**
 * Admin panel for the context budget (lib/services/contextBudget/types.ts).
 *
 * One document, one CAS'd PUT with If-Match; on 409 the admin is told
 * another admin won the race and the settings are reloaded. The server
 * component gates access; this client is presentation only. Defaults,
 * bounds and the catalog all come from the API, so nothing here can drift
 * from what the server enforces. The table at the bottom shows what each
 * model would actually be sent under the draft — the budget rules are the
 * same pure function the server runs.
 */
export const ContextBudgetPanel: FC = () => {
  const t = useTranslations('contextBudgetAdmin');
  const { query, save } = useContextBudgetAdmin();
  const [draft, setDraft] = useState<ResolvedContextBudgetConfig>({
    ...CONTEXT_BUDGET_DEFAULTS,
  });
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newOverride, setNewOverride] = useState<
    Record<OverrideKey, { id: string; tokens: string }>
  >({
    familyOverrides: { id: '', tokens: '' },
    modelOverrides: { id: '', tokens: '' },
  });
  // Seed the draft from each NEW server response during render (the
  // "storing information from previous renders" pattern) rather than in an
  // effect, so a reload after a 409 replaces the stale draft in the same
  // pass and never flashes the old values.
  const [seededFrom, setSeededFrom] =
    useState<ContextBudgetConfigResponse | null>(null);
  if (
    query.data &&
    query.data !== seededFrom &&
    !query.data.configUnavailable
  ) {
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setDraft(resolveContextBudgetConfig(query.data.config));
    setDirty(false);
  }

  const update = (patch: Partial<ResolvedContextBudgetConfig>) => {
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

  const { config, defaults, bounds, families, models } = query.data;

  const clampInt = (key: NumericKey, value: number): number => {
    const { min, max } = bounds[key];
    if (!Number.isFinite(value)) return defaults[key];
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  const clampFraction = (value: number): number => {
    const { min, max } = bounds.historyFraction;
    if (!Number.isFinite(value)) return defaults.historyFraction;
    return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
  };
  const clampOverride = (value: number): number | null => {
    const { min, max } = bounds.overrideTokens;
    if (!Number.isFinite(value)) return null;
    return Math.min(max, Math.max(min, Math.round(value)));
  };

  const handleSave = async () => {
    try {
      const result = await save.mutateAsync({
        budget: overridesOf(draft, defaults),
        etag,
      });
      setEtag(result.etag);
      setDirty(false);
      toast.success(t('saveSuccess'));
    } catch (error) {
      if (error instanceof ContextBudgetConfigConflict) {
        toast.error(t('conflictError'));
        await query.refetch();
        return;
      }
      toast.error(t('saveError'));
    }
  };

  const addOverride = (key: OverrideKey) => {
    const entry = newOverride[key];
    const id = entry.id.trim();
    const tokens = clampOverride(Number(entry.tokens));
    if (!id || tokens === null) return;
    update({ [key]: { ...draft[key], [id]: tokens } });
    setNewOverride((prev) => ({ ...prev, [key]: { id: '', tokens: '' } }));
  };
  const removeOverride = (key: OverrideKey, id: string) => {
    const next = { ...draft[key] };
    delete next[id];
    update({ [key]: next });
  };

  const numberRow = (
    key: NumericKey,
    labelKey: string,
    descriptionKey: string,
    opts: { step: number; fraction?: boolean },
  ) => {
    const inputId = `context-budget-${key}`;
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
            className={`${ADMIN_FIELD} w-32`}
            min={min}
            max={max}
            step={opts.step}
            value={draft[key]}
            onChange={(e) =>
              update({
                [key]: opts.fraction
                  ? clampFraction(e.target.valueAsNumber)
                  : clampInt(key, e.target.valueAsNumber),
              })
            }
          />
          <span className={ADMIN_MUTED}>{t('rangeHint', { min, max })}</span>
        </div>
        <p className={ADMIN_HINT}>{t(descriptionKey)}</p>
        <p className={ADMIN_HINT}>
          {t('defaultHint', { value: defaults[key] })}
        </p>
      </li>
    );
  };

  const overrideRow = (
    key: OverrideKey,
    labelKey: string,
    descriptionKey: string,
    idPlaceholderKey: string,
    datalistId: string,
    choices: Array<{ id: string; label: string }>,
  ) => {
    const entries = Object.entries(draft[key]);
    const labelOf = (id: string) =>
      choices.find((choice) => choice.id === id)?.label ?? id;
    return (
      <li className={ADMIN_ROW}>
        <span className={ADMIN_LABEL}>{t(labelKey)}</span>
        <p className={ADMIN_HINT}>{t(descriptionKey)}</p>
        <ul className="mt-2 space-y-1" aria-label={t(labelKey)}>
          {entries.length === 0 && (
            <li className={ADMIN_MUTED}>{t('noOverrides')}</li>
          )}
          {entries.map(([id, tokens]) => (
            <li key={id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-black dark:text-white">
                {labelOf(id)}
                {labelOf(id) !== id && (
                  <span className={`ms-1 ${ADMIN_MUTED}`}>({id})</span>
                )}
              </span>
              <span className="tabular-nums">{formatTokens(tokens)}</span>
              <button
                type="button"
                className={`${ADMIN_BTN_SECONDARY} px-2 py-1`}
                aria-label={`${t('removeOverride')} ${id}`}
                onClick={() => removeOverride(key, id)}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            className={`${ADMIN_FIELD} w-48`}
            list={datalistId}
            placeholder={t(idPlaceholderKey)}
            aria-label={t(idPlaceholderKey)}
            value={newOverride[key].id}
            onChange={(e) =>
              setNewOverride((prev) => ({
                ...prev,
                [key]: { ...prev[key], id: e.target.value },
              }))
            }
          />
          <datalist id={datalistId}>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </datalist>
          <input
            type="number"
            className={`${ADMIN_FIELD} w-32`}
            min={bounds.overrideTokens.min}
            max={bounds.overrideTokens.max}
            step={1000}
            placeholder={t('overrideTokensPlaceholder')}
            aria-label={t('overrideTokensPlaceholder')}
            value={newOverride[key].tokens}
            onChange={(e) =>
              setNewOverride((prev) => ({
                ...prev,
                [key]: { ...prev[key], tokens: e.target.value },
              }))
            }
          />
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={() => addOverride(key)}
          >
            {t('addOverride')}
          </button>
        </div>
        <p className={ADMIN_HINT}>
          {t('defaultHint', {
            value:
              Object.entries(defaults[key])
                .map(([id, tokens]) => `${id}: ${formatTokens(tokens)}`)
                .join(', ') || t('noOverrides'),
          })}
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
          {numberRow(
            'historyTokens',
            'historyTokensLabel',
            'historyTokensDescription',
            { step: 1000 },
          )}
          {numberRow(
            'historyFraction',
            'historyFractionLabel',
            'historyFractionDescription',
            { step: 0.05, fraction: true },
          )}
          {numberRow(
            'minRecentMessages',
            'minRecentMessagesLabel',
            'minRecentMessagesDescription',
            { step: 1 },
          )}
          {overrideRow(
            'familyOverrides',
            'familyOverridesLabel',
            'familyOverridesDescription',
            'overrideFamilyPlaceholder',
            'context-budget-families',
            families,
          )}
          {overrideRow(
            'modelOverrides',
            'modelOverridesLabel',
            'modelOverridesDescription',
            'overrideModelPlaceholder',
            'context-budget-models',
            models.map((model) => ({ id: model.id, label: model.name })),
          )}
        </ul>
        <p className={ADMIN_HINT}>{t('defaultsNote')}</p>
      </section>

      <section className={ADMIN_CARD}>
        <h3 className="text-sm font-semibold text-black dark:text-white">
          {t('effectiveLabel')}
        </h3>
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className={ADMIN_MUTED}>
              <th scope="col" className="py-1 text-left font-medium">
                {t('effectiveColumnModel')}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t('effectiveColumnWindow')}
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                {t('effectiveColumnBudget')}
              </th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => {
              const budget = resolveHistoryBudget(model, draft);
              return (
                <tr key={model.id} className="text-black dark:text-white">
                  <td className="py-0.5 pr-2">
                    {model.name}
                    <span className={`ms-1 ${ADMIN_MUTED}`}>({model.id})</span>
                  </td>
                  <td className="py-0.5 text-right tabular-nums">
                    {formatTokens(model.maxLength)}
                  </td>
                  <td
                    className="py-0.5 text-right tabular-nums"
                    data-testid={`budget-${model.id}`}
                  >
                    {formatTokens(budget.tokens)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
