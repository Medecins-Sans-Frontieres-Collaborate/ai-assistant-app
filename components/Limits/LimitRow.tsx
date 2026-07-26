'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { ADMIN_CHECKBOX, ADMIN_MUTED } from '@/components/Admin/adminClasses';
import { LimitValueInput } from '@/components/Limits/LimitValueInput';
import { ScopedLimitRows } from '@/components/Limits/ScopedLimitRows';
import { EntryDraft, draftKey } from '@/components/Limits/types';

import { LimitDefinition } from '@/config/limits';

interface LimitRowProps {
  def: LimitDefinition;
  /** The whole draft — ScopedLimitRows finds its cells by prefix. */
  draft: EntryDraft;
  onChange: (key: string, value: EntryDraft[string]) => void;
  /** Catalog description under the label (defaults tab). */
  showDescription?: boolean;
  /**
   * Hard-ceiling toggle state; rendered only when provided AND the row is
   * configured — override rows never pass it (override-level ceilings are
   * inert and stay invisible-but-preserved).
   */
  ceiling?: { checked: boolean; onToggle: (checked: boolean) => void };
  /**
   * The row's feature gate is off, so this value cannot take effect. The
   * row dims and shows `dimmedNote`; the draft is NEVER written — the
   * value must survive the gate being turned back on.
   */
  dimmed?: boolean;
  /** Pre-translated note explaining why the row is dimmed. */
  dimmedNote?: string;
  /**
   * Whether dimming also disables the inputs. True on the defaults tab
   * (the gate below it is the single source of truth); false in override
   * cards, where a higher-priority layer may re-enable the gate for some
   * of the targeted people, so editing must stay possible.
   */
  disableWhenDimmed?: boolean;
  /** Pre-translated consequence copy rendered under the control. */
  consequenceNote?: string;
  disabled?: boolean;
}

/**
 * One limit row, shared by the defaults tab and the override editor. Label
 * (+ optional description), the universal value control, the optional
 * hard-ceiling toggle, and nested per-model rows for perModel keys.
 */
export const LimitRow: FC<LimitRowProps> = ({
  def,
  draft,
  onChange,
  showDescription = false,
  ceiling,
  dimmed = false,
  dimmedNote,
  disableWhenDimmed = false,
  consequenceNote,
  disabled = false,
}) => {
  const t = useTranslations('limits');
  const key = draftKey(def.key);
  const configured = draft[key] !== undefined;
  const effectiveDisabled = disabled || (dimmed && disableWhenDimmed);

  return (
    <div className={dimmed ? 'opacity-60' : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-[200px] flex-1">
          <div className="text-sm font-medium text-black dark:text-white">
            {t(`label.${def.labelKey}` as never)}
          </div>
          {showDescription && (
            <div className={ADMIN_MUTED}>
              {t(`descriptionByKey.${def.labelKey}` as never)}
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <LimitValueInput
            def={def}
            value={draft[key]}
            onChange={(value) => onChange(key, value)}
            disabled={effectiveDisabled}
          />
          {ceiling && configured && (
            <label className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <input
                type="checkbox"
                className={ADMIN_CHECKBOX}
                checked={ceiling.checked}
                onChange={(e) => ceiling.onToggle(e.target.checked)}
                disabled={effectiveDisabled}
              />
              {t('hardCeilingToggle')}
            </label>
          )}
        </div>
        {/* Per-family and per-model rows. A family cap is an envelope over
            its models, not an alternative to them — the resolver checks
            both. */}
        {def.perModel && (
          <div className="w-full">
            <ScopedLimitRows
              def={def}
              draft={draft}
              onChange={onChange}
              disabled={effectiveDisabled}
            />
          </div>
        )}
      </div>
      {dimmed && dimmedNote && <p className={ADMIN_MUTED}>{dimmedNote}</p>}
      {!dimmed && consequenceNote && (
        <p className={ADMIN_MUTED}>{consequenceNote}</p>
      )}
    </div>
  );
};
