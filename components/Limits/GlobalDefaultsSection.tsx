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
import { LimitValueInput } from '@/components/Limits/LimitValueInput';
import { ScopedLimitRows } from '@/components/Limits/ScopedLimitRows';
import {
  EntryDraft,
  ceilingsFromEntries,
  draftKey,
  draftToEntries,
  entriesToDraft,
} from '@/components/Limits/types';

import { LIMIT_DEFINITIONS, LimitCategory } from '@/config/limits';

interface GlobalDefaultsSectionProps {
  entries: LimitEntry[];
  onChange: (entries: LimitEntry[]) => void;
  disabled?: boolean;
}

const CATEGORY_ORDER: LimitCategory[] = [
  'chat',
  'models',
  'tools',
  'files',
  'speech',
  'documents',
];

/**
 * Org-wide defaults, generated entirely from the compiled catalog so a new
 * limit key appears here the moment it is enforceable — and one that is not
 * in the catalog can never be configured.
 *
 * There is no layer below a global default, so "Not set" here means the
 * compiled catalog default (almost always unlimited) rather than inheritance.
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

  return (
    <div className="space-y-6">
      {CATEGORY_ORDER.map((category) => {
        const defs = LIMIT_DEFINITIONS.filter((d) => d.category === category);
        if (defs.length === 0) return null;
        return (
          <section key={category}>
            <h3 className={ADMIN_HEADING}>
              {t(`category.${category}` as never)}
            </h3>
            <div className="space-y-3">
              {defs.map((def) => {
                const key = draftKey(def.key);
                const configured = draft[key] !== undefined;
                return (
                  <div
                    key={def.key}
                    className={`flex flex-wrap items-center justify-between gap-2 ${ADMIN_ROW}`}
                  >
                    <div className="min-w-[200px] flex-1">
                      <div className="text-sm font-medium text-black dark:text-white">
                        {t(`label.${def.labelKey}` as never)}
                      </div>
                      <div className={ADMIN_MUTED}>
                        {t(`descriptionByKey.${def.labelKey}` as never)}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <LimitValueInput
                        def={def}
                        value={draft[key]}
                        onChange={(value) => setValue(key, value)}
                        disabled={disabled}
                      />
                      {configured && (
                        <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                          <input
                            type="checkbox"
                            className={ADMIN_CHECKBOX}
                            checked={ceilings[key] ?? false}
                            onChange={(e) => setCeiling(key, e.target.checked)}
                            disabled={disabled}
                          />
                          {t('hardCeilingToggle')}
                        </label>
                      )}
                    </div>
                    {/* Per-family and per-model rows. A family cap is an
                        envelope over its models, not an alternative to them —
                        the resolver checks both. */}
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
          </section>
        );
      })}
    </div>
  );
};
