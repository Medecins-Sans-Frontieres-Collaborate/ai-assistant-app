'use client';

import { FC } from 'react';

import { useTranslations } from 'next-intl';

import { LimitsFailMode, LimitsMode } from '@/lib/services/limits/types';
import type { UsageInsights } from '@/lib/services/limits/wire';

import {
  ADMIN_BTN_SECONDARY,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { LimitsDraft } from '@/components/Limits/limitsDraft';

import { getLimitDefinition } from '@/config/limits';

interface LimitsSettingsStripProps {
  draft: LimitsDraft;
  onChange: (patch: Partial<LimitsDraft>) => void;
  insights: UsageInsights | undefined;
  disabled: boolean;
  onOpenDelegations: () => void;
}

/**
 * The state of the whole policy at a glance: observe or enforce (with what
 * the last week says enforcing would have stopped), who else can change
 * limits, and the rarely touched settings behind a disclosure.
 */
export const LimitsSettingsStrip: FC<LimitsSettingsStripProps> = ({
  draft,
  onChange,
  insights,
  disabled,
  onOpenDelegations,
}) => {
  const t = useTranslations('limits');
  const cells = Object.values(insights?.cells ?? {});
  const events = cells.reduce((sum, cell) => sum + cell.events, 0);
  const busiest = [...cells].sort((a, b) => b.events - a.events)[0];
  const busiestDef = busiest ? getLimitDefinition(busiest.limitKey) : undefined;
  const delegations = draft.delegations;

  return (
    <div className="mb-4 flex flex-wrap gap-4">
      <section className="min-w-[18rem] flex-1 basis-80 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
        <h2 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
          {t('modeLabel')}
        </h2>
        <div
          role="radiogroup"
          aria-label={t('modeLabel')}
          className="grid grid-cols-2 overflow-hidden rounded-lg border border-gray-300 dark:border-gray-600"
        >
          {(['observe', 'enforce'] as LimitsMode[]).map((mode) => (
            <label
              key={mode}
              className={`flex h-9 cursor-pointer items-center justify-center text-sm focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500 ${
                draft.mode === mode
                  ? 'bg-gray-900 font-semibold text-white dark:bg-gray-100 dark:text-gray-900'
                  : 'bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100'
              }`}
            >
              <input
                type="radio"
                className="sr-only"
                name="limits-mode"
                checked={draft.mode === mode}
                onChange={() => onChange({ mode })}
                disabled={disabled}
              />
              {mode === 'observe' ? t('modeObserve') : t('modeEnforce')}
            </label>
          ))}
        </div>
        <p className="mt-2 text-sm text-gray-800 dark:text-gray-200">
          {draft.mode === 'observe'
            ? t('console.observeSentence')
            : t('console.enforceSentence')}
        </p>
        {insights && insights.days.length > 0 && (
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            {events === 0
              ? t('console.noHits', { days: insights.days.length })
              : t(
                  draft.mode === 'observe'
                    ? 'console.wouldHaveStopped'
                    : 'console.stopped',
                  {
                    days: insights.days.length,
                    events,
                    limit: busiestDef
                      ? t(`label.${busiestDef.labelKey}` as never)
                      : '',
                  },
                )}
          </p>
        )}
      </section>

      <section className="min-w-[18rem] flex-1 basis-72 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
        <h2 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">
          {t('console.delegatedTitle')}
        </h2>
        <p className={`mb-2 ${ADMIN_MUTED}`}>{t('console.delegatedHint')}</p>
        {delegations.length === 0 ? (
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t('console.delegatedNone')}
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm text-gray-800 dark:text-gray-200">
            {delegations.map((delegation) => (
              <li
                key={delegation.id}
                className="rounded-md border border-dashed border-gray-400 px-2 py-1.5 dark:border-gray-500"
              >
                <strong>{delegation.label || t('untitledDelegation')}</strong>
                {' · '}
                {t('console.delegatedLine', {
                  admins: delegation.admins.length,
                  used: draft.overrides.filter(
                    (o) => o.delegationId === delegation.id,
                  ).length,
                  budget: delegation.maxOverrides,
                })}
                {!delegation.enabled && ` · ${t('delegationDisabledChip')}`}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className={`mt-2 ${ADMIN_BTN_SECONDARY}`}
          onClick={onOpenDelegations}
        >
          {t('console.openDelegations')}
        </button>
      </section>

      <section className="min-w-[18rem] flex-1 basis-72 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-surface-dark">
        <details>
          <summary className="flex min-h-8 cursor-pointer items-center text-sm font-semibold text-gray-900 dark:text-white">
            {t('console.settingsTitle')}
          </summary>
          <div className="mt-2 space-y-3">
            <label className="flex flex-wrap items-center gap-2 text-sm text-gray-900 dark:text-white">
              {t('failModeLabel')}
              <select
                className={ADMIN_FIELD}
                value={draft.failMode}
                onChange={(event) =>
                  onChange({ failMode: event.target.value as LimitsFailMode })
                }
                disabled={disabled}
              >
                <option value="open">{t('failOpen')}</option>
                <option value="closed">{t('failClosed')}</option>
              </select>
            </label>
            <label className="flex flex-wrap items-center gap-2 text-sm text-gray-900 dark:text-white">
              {t('timezoneLabel')}
              <input
                type="text"
                className={`w-44 ${ADMIN_FIELD}`}
                value={draft.timezone}
                onChange={(event) => onChange({ timezone: event.target.value })}
                disabled={disabled}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
              <input
                type="checkbox"
                className={ADMIN_CHECKBOX}
                checked={draft.countByomUsage}
                onChange={(event) =>
                  onChange({ countByomUsage: event.target.checked })
                }
                disabled={disabled}
              />
              {t('countByom')}
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
              <input
                type="checkbox"
                className={ADMIN_CHECKBOX}
                checked={draft.countAuxiliaryUsage}
                onChange={(event) =>
                  onChange({ countAuxiliaryUsage: event.target.checked })
                }
                disabled={disabled}
              />
              {t('countAuxiliary')}
            </label>
          </div>
        </details>
      </section>
    </div>
  );
};
