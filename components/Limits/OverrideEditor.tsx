'use client';

import { IconTrash } from '@tabler/icons-react';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { LimitOverride, OverrideScope } from '@/lib/services/limits/types';

import {
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_LABEL,
} from '@/components/Admin/adminClasses';
import { ChipListInput } from '@/components/AgentAccess/ChipListInput';
import { normalizeDomainEntry } from '@/components/AgentAccess/RuleEditor';
import { LimitValueInput } from '@/components/Limits/LimitValueInput';
import { ScopedLimitRows } from '@/components/Limits/ScopedLimitRows';
import {
  EntryDraft,
  ceilingsFromEntries,
  draftKey,
  draftToEntries,
  entriesToDraft,
} from '@/components/Limits/types';

import { LIMIT_DEFINITIONS } from '@/config/limits';

interface OverrideEditorProps {
  override: LimitOverride;
  onChange: (next: LimitOverride) => void;
  onRemove: () => void;
  disabled?: boolean;
}

const SCOPES: OverrideScope[] = ['user', 'domain', 'attribute', 'group'];

/**
 * One override record: who it targets, and the sparse set of limits it
 * speaks to. Everything it does NOT set is left absent, so lower layers keep
 * applying — that is the whole point of the sparse merge.
 *
 * The `group` scope is rendered DISABLED with pending-consent copy, matching
 * the treatment `RuleEditor` already gives `allowGroups`: Entra group
 * membership is not on the session, so a group override would grant and deny
 * nothing. Stored group targets are preserved untouched on save so nothing is
 * lost when consent lands.
 */
export const OverrideEditor: FC<OverrideEditorProps> = ({
  override,
  onChange,
  onRemove,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const draft: EntryDraft = useMemo(
    () => entriesToDraft(override.entries),
    [override.entries],
  );
  const isGroupScope = override.scope === 'group';

  const update = (patch: Partial<LimitOverride>) =>
    onChange({ ...override, ...patch });

  /**
   * ⚠ `ceilings` MUST be threaded through every draftToEntries call.
   * draftToEntries defaults the argument to {} and then writes
   * `ceiling: ceilings[key] ?? false` for EVERY entry — so without this, one
   * keystroke on any limit rewrote the whole entry array with ceiling:false
   * and silently destroyed stored flags. The write schema
   * (app/api/limits/policy/route.ts) accepts and persists ceiling on override
   * entries, so that was real data loss.
   *
   * Preserved rather than stripped: resolver.ts reads only the GLOBAL entry's
   * ceiling, so an override-level ceiling is inert today — but silently
   * flipping a stored `true` is mutation, and a future resolver change could
   * make it meaningful.
   */
  const ceilings = useMemo(
    () => ceilingsFromEntries(override.entries),
    [override.entries],
  );

  const setValue = (key: string, value: EntryDraft[string]) => {
    const next = { ...draft, [key]: value };
    if (value === undefined) delete next[key];
    update({ entries: draftToEntries(next, ceilings) });
  };

  return (
    <div className={ADMIN_CARD}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          className={`min-w-[180px] flex-1 ${ADMIN_FIELD}`}
          value={override.label}
          onChange={(e) => update({ label: e.target.value })}
          placeholder={t('overrideLabelPlaceholder')}
          disabled={disabled}
          aria-label={t('overrideLabelLabel')}
        />
        <select
          className={ADMIN_FIELD}
          value={override.scope}
          onChange={(e) =>
            update({ scope: e.target.value as OverrideScope, targets: [] })
          }
          disabled={disabled}
          aria-label={t('overrideScopeLabel')}
        >
          {SCOPES.map((scope) => (
            <option key={scope} value={scope}>
              {t(`scope.${scope}` as never)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
          <input
            type="checkbox"
            className={ADMIN_CHECKBOX}
            checked={override.enabled}
            onChange={(e) => update({ enabled: e.target.checked })}
            disabled={disabled}
          />
          {t('overrideEnabled')}
        </label>
        <button
          type="button"
          className={ADMIN_BTN_ICON_DANGER}
          onClick={onRemove}
          disabled={disabled}
          aria-label={t('removeOverride')}
        >
          <IconTrash size={16} />
        </button>
      </div>

      {isGroupScope && (
        <p className={`mb-2 ${ADMIN_BANNER_WARN}`}>
          {t('groupsPendingConsent')}
        </p>
      )}

      <div className="mb-3">
        <label className={ADMIN_LABEL}>
          {t(`targetsLabel.${override.scope}` as never)}
        </label>
        <ChipListInput
          values={override.targets}
          onChange={(targets) => update({ targets })}
          normalize={
            override.scope === 'domain' ? normalizeDomainEntry : undefined
          }
          placeholder={t(`targetsPlaceholder.${override.scope}` as never)}
          addHint={t('chipAddHint')}
          removeLabel={t('removeChip')}
          disabled={disabled || isGroupScope}
        />
      </div>

      <div className="space-y-2">
        {LIMIT_DEFINITIONS.map((def) => {
          const key = draftKey(def.key);
          return (
            <div
              key={def.key}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-2 dark:border-gray-700"
            >
              <span className="text-sm text-black dark:text-white">
                {t(`label.${def.labelKey}` as never)}
              </span>
              <LimitValueInput
                def={def}
                value={draft[key]}
                onChange={(value) => setValue(key, value)}
                disabled={disabled}
              />
              {def.perModel && (
                <div className="w-full">
                  <ScopedLimitRows
                    def={def}
                    draft={draft}
                    onChange={setValue}
                    disabled={disabled}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
