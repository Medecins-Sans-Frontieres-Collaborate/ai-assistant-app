'use client';

import { IconPlus, IconTrash } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  buildQualifierCatalog,
  isUnknownQualifier,
  qualifierLabel,
} from '@/lib/utils/app/limitsModelCatalog';

import {
  ADMIN_BTN_ICON_DANGER,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { CostHint } from '@/components/Limits/CostHint';
import { LimitValueInput } from '@/components/Limits/LimitValueInput';
import { seedValueFor } from '@/components/Limits/limitGroups';
import { EntryDraft, draftKey, parseDraftKey } from '@/components/Limits/types';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { LimitDefinition } from '@/config/limits';

interface ScopedLimitRowsProps {
  def: LimitDefinition;
  /** The whole draft — scoped cells are found by prefix. */
  draft: EntryDraft;
  onChange: (key: string, value: EntryDraft[string]) => void;
  disabled?: boolean;
}

/**
 * Per-family and per-model rows for a `perModel` limit, nested under its
 * "all models" row.
 *
 * SEMANTICS THIS UI MUST NOT MISREPRESENT — the resolver checks the chat
 * total, the family cell and the model cell CONJUNCTIVELY: a request has to
 * satisfy all three. So "GPT family = 500/day" and "GPT-5.2 = 50/day" means
 * GPT-5.2 is capped at 50 AND counts toward the family's 500. The copy calls
 * the family an envelope and the model a sub-cap rather than implying the
 * more specific one replaces the other.
 *
 * ⚠ A NEW SCOPED ROW IS NEVER SEEDED AT "UNLIMITED". `pickGlobalEntry` ranks
 * by qualifier specificity BEFORE restrictiveness, so a family entry of null
 * (specificity 1) would beat an unqualified 100 (specificity 0) and silently
 * make that entire family unlimited. Boolean keys seed blocked, counters seed
 * a concrete number.
 */
export const ScopedLimitRows: FC<ScopedLimitRowsProps> = ({
  def,
  draft,
  onChange,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const models = useSettingsStore((s) => s.models);
  const [pending, setPending] = useState('');

  const catalog = useMemo(() => buildQualifierCatalog(models), [models]);

  /** Existing scoped cells for THIS limit key, in stored order. */
  const scoped = useMemo(
    () =>
      Object.keys(draft)
        .filter((key) => key.startsWith(`${def.key}@`))
        .map((key) => ({ key, ...parseDraftKey(key) })),
    [draft, def.key],
  );

  const addQualifier = (raw: string) => {
    if (!raw) return;
    const [kind, value] = raw.split(':');
    const key =
      kind === 'family'
        ? draftKey(def.key, undefined, value)
        : draftKey(def.key, value, undefined);
    if (draft[key] !== undefined) return; // already present
    // Never null — see the docblock; seedValueFor owns the rule.
    onChange(key, seedValueFor(def));
    setPending('');
  };

  return (
    <div className="mt-2 space-y-2 border-l border-gray-200 pl-3 dark:border-gray-700">
      {scoped.map(({ key, modelId, series }) => {
        const unknown = isUnknownQualifier(catalog, { modelId, series });
        return (
          <div
            key={key}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div className="flex min-w-[180px] flex-1 flex-wrap items-center gap-1.5">
              <span className={ADMIN_CHIP_NEUTRAL}>
                {series ? t('scopeFamily') : t('scopeModel')}
              </span>
              <span className="text-sm text-black dark:text-white">
                {qualifierLabel(catalog, { modelId, series })}
              </span>
              {unknown && (
                // Expected, not corrupt: ids vary per ring/region and a stored
                // limit must survive a model's absence.
                <span className={ADMIN_MUTED} title={t('unknownQualifierHint')}>
                  {t('unknownQualifier')}
                </span>
              )}
            </div>
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5">
                <LimitValueInput
                  def={def}
                  value={draft[key]}
                  onChange={(value) => onChange(key, value)}
                  disabled={disabled}
                />
                <button
                  type="button"
                  className={ADMIN_BTN_ICON_DANGER}
                  onClick={() => onChange(key, undefined)}
                  disabled={disabled}
                  aria-label={t('removeScopedLimit')}
                >
                  <IconTrash size={16} />
                </button>
              </div>
              {/* Cost annotation (limitsCostInsights): the qualifier's own
                  price — a model's request, a family's min–max — or "no
                  price data"; nothing for model.allowed or blocked cells. */}
              <CostHint
                def={def}
                value={draft[key]}
                modelId={modelId}
                series={series}
                draft={draft}
              />
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-1.5">
        <IconPlus size={14} className="text-gray-500 dark:text-gray-400" />
        <select
          className={ADMIN_FIELD}
          value={pending}
          onChange={(e) => addQualifier(e.target.value)}
          disabled={disabled}
          aria-label={t('addScopedLimit')}
        >
          <option value="">{t('addScopedLimit')}</option>
          {catalog.families.length > 0 && (
            <optgroup label={t('families')}>
              {catalog.families.map((family) => (
                <option key={family.series} value={`family:${family.series}`}>
                  {family.label}
                </option>
              ))}
            </optgroup>
          )}
          {catalog.models.length > 0 && (
            <optgroup label={t('modelsGroup')}>
              {catalog.models.map((model) => (
                <option key={model.modelId} value={`model:${model.modelId}`}>
                  {model.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>
    </div>
  );
};
