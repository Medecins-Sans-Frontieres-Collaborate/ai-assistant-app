'use client';

import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { LimitEntry } from '@/lib/services/limits/types';

import {
  ADMIN_CHECKBOX,
  ADMIN_HEADING,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';
import { LimitRow } from '@/components/Limits/LimitRow';
import { LimitValueInput } from '@/components/Limits/LimitValueInput';
import {
  LIMIT_GROUPS,
  LimitGroup,
  memberDefinitions,
} from '@/components/Limits/limitGroups';
import {
  EntryDraft,
  ceilingsFromEntries,
  draftKey,
  draftToEntries,
  entriesToDraft,
} from '@/components/Limits/types';

import { getLimitDefinition } from '@/config/limits';

interface GlobalDefaultsSectionProps {
  entries: LimitEntry[];
  onChange: (entries: LimitEntry[]) => void;
  disabled?: boolean;
}

/**
 * Org-wide defaults, grouped by FEATURE rather than by mechanical kind: a
 * feature's on/off gate renders in its group header with its caps directly
 * under it, so "Code interpreter" and "Code interpreter runs per day" can
 * no longer drift four unrelated rows apart.
 *
 * When a gate is explicitly Blocked, its caps are dead configuration (the
 * gate refuses the request before any counter is consumed) — those rows
 * dim AND disable, with their values preserved untouched so they take
 * effect again the moment the gate is re-enabled. Where gate-off and
 * cap-blocked genuinely differ for users (hard refusal vs silently
 * skipping the tool), the copy says so inline.
 *
 * Still generated entirely from the compiled catalog (via the grouping map,
 * whose drift guard forces every catalog key into a group), so a new limit
 * key appears here the moment it is enforceable.
 *
 * There is no layer below a global default, so "Not set" here means the
 * compiled catalog default (almost always unlimited) rather than
 * inheritance.
 */
export const GlobalDefaultsSection: FC<GlobalDefaultsSectionProps> = ({
  entries,
  onChange,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const draft: EntryDraft = useMemo(() => entriesToDraft(entries), [entries]);
  const ceilings = useMemo(() => ceilingsFromEntries(entries), [entries]);

  const commit = (nextDraft: EntryDraft, nextCeilings = ceilings) =>
    onChange(draftToEntries(nextDraft, nextCeilings));

  const setValue = (key: string, value: EntryDraft[string]) => {
    const next = { ...draft, [key]: value };
    if (value === undefined) delete next[key];
    commit(next);
  };

  const setCeiling = (key: string, ceiling: boolean) =>
    commit(draft, { ...ceilings, [key]: ceiling });

  const renderGroup = (group: LimitGroup) => {
    const gateDef = group.gateKey
      ? getLimitDefinition(group.gateKey)
      : undefined;
    const gateDraftKey = group.gateKey ? draftKey(group.gateKey) : undefined;
    // Only an explicit false dims: unset means the catalog default (true).
    const gateOff = gateDraftKey !== undefined && draft[gateDraftKey] === false;
    const gateConfigured =
      gateDraftKey !== undefined && draft[gateDraftKey] !== undefined;

    return (
      <section key={group.id} aria-labelledby={`limits-group-${group.id}`}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-[200px]">
            <h3 id={`limits-group-${group.id}`} className={ADMIN_HEADING}>
              {t(`group.${group.id}` as never)}
            </h3>
            {gateDef && (
              <p className={ADMIN_MUTED}>
                {t(`descriptionByKey.${gateDef.labelKey}` as never)}
              </p>
            )}
          </div>
          {gateDef && gateDraftKey && (
            <div className="flex flex-col items-end gap-1">
              <LimitValueInput
                def={gateDef}
                value={draft[gateDraftKey]}
                onChange={(value) => setValue(gateDraftKey, value)}
                disabled={disabled}
              />
              {gateConfigured && (
                <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                  <input
                    type="checkbox"
                    className={ADMIN_CHECKBOX}
                    checked={ceilings[gateDraftKey] ?? false}
                    onChange={(e) => setCeiling(gateDraftKey, e.target.checked)}
                    disabled={disabled}
                  />
                  {t('hardCeilingToggle')}
                </label>
              )}
            </div>
          )}
        </div>

        {/* Gate-off is a hard refusal with an admin message — different
            from a blocked cap, which silently skips the tool. Said here,
            where the admin just made the choice. */}
        {gateOff && group.consequenceKey && (
          <p className={`mb-2 ${ADMIN_MUTED}`}>
            {t(`gateOffConsequence.${group.consequenceKey}` as never)}
          </p>
        )}

        <div className="space-y-3">
          {memberDefinitions(group).map((def) => {
            const memberKey = draftKey(def.key);
            const capBlocked =
              draft[memberKey] === 0 || draft[memberKey] === false;
            return (
              <div key={def.key} className={ADMIN_ROW}>
                <LimitRow
                  def={def}
                  draft={draft}
                  onChange={setValue}
                  showDescription
                  ceiling={{
                    checked: ceilings[memberKey] ?? false,
                    onToggle: (checked) => setCeiling(memberKey, checked),
                  }}
                  dimmed={gateOff}
                  dimmedNote={t('gateOffDimNote', {
                    feature: t(`group.${group.id}` as never),
                  })}
                  disableWhenDimmed
                  consequenceNote={
                    capBlocked && group.consequenceKey && !def.perModel
                      ? t(
                          `capBlockedConsequence.${group.consequenceKey}` as never,
                        )
                      : undefined
                  }
                  disabled={disabled}
                />
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  return <div className="space-y-6">{LIMIT_GROUPS.map(renderGroup)}</div>;
};
