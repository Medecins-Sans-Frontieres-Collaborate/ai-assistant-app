'use client';

import { IconSearch } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  MyLimit,
  PreviewUsage,
  useEffectiveLimitsPreview,
} from '@/client/hooks/settings/useLimitsAdmin';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import { counterCellName } from '@/lib/services/limits/resolver';
import { LimitOverride } from '@/lib/services/limits/types';

import {
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { LIMIT_GROUPS } from '@/components/Limits/limitGroups';
import { EmailAutocompleteInput } from '@/components/UI/EmailAutocompleteInput';

import { getLimitDefinition } from '@/config/limits';

interface EffectiveLimitsPreviewProps {
  /** Current draft overrides, for mapping a winning overrideId to a name. */
  overrides: LimitOverride[];
  /** The panel has unsaved edits — the preview reflects the SAVED policy. */
  dirty: boolean;
  /**
   * Replaces the default 403 copy ("only global admins can preview"). A
   * scoped admin's 403 means "outside your scope" (design §6c), and reusing
   * the global sentence there would be a false statement.
   */
  forbiddenMessage?: string;
  /** Pre-translated note under the description — e.g. group-only scope. */
  scopeNote?: string;
}

/** Stable display order: group order, then member order within the group. */
const KEY_ORDER = new Map<string, number>(
  LIMIT_GROUPS.flatMap((group) => [
    ...(group.gateKey ? [group.gateKey] : []),
    ...group.memberKeys,
  ]).map((key, index) => [key, index]),
);

/**
 * "Check what a person actually gets": resolves a user's effective limits
 * against the SAVED policy via the admin `/api/limits/me?as=` preview, and
 * names the winning layer for every key — the answer to "which override
 * wins" that the editor cards alone cannot give. Since delegations it also
 * says which authority TIER won and, when a ceiling pinned the value, which
 * record pinned it (design §6c: a scoped admin must see WHY their 500 became
 * 100), and can attach the subject's current consumption (`&usage=1`).
 */
export const EffectiveLimitsPreview: FC<EffectiveLimitsPreviewProps> = ({
  overrides,
  dirty,
  forbiddenMessage,
  scopeNote,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [withUsage, setWithUsage] = useState(false);
  const { result, forbidden, isLoading, error } = useEffectiveLimitsPreview(
    submitted,
    { usage: withUsage },
  );

  const rows = useMemo(() => {
    if (!result) return [];
    return [...result.limits].sort((a, b) => {
      const orderA = KEY_ORDER.get(a.limitKey) ?? Number.MAX_SAFE_INTEGER;
      const orderB = KEY_ORDER.get(b.limitKey) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      // Base row before its qualified cells.
      const qualifierA = a.modelId ?? a.series ?? '';
      const qualifierB = b.modelId ?? b.series ?? '';
      return qualifierA.localeCompare(qualifierB);
    });
  }, [result]);

  const check = () => {
    const mail = input.trim().toLowerCase();
    setSubmitted(mail.length > 0 ? mail : null);
  };

  const sourceLabel = (limit: MyLimit): string => {
    if (limit.overrideId) {
      const match = overrides.find((o) => o.id === limit.overrideId);
      return t('previewSourceOverride', {
        label: match?.label || limit.overrideId,
      });
    }
    if (limit.source === 'global') return t('previewSourceGlobal');
    return t('previewSourceCatalog');
  };

  /**
   * Who pinned the value: the server's label for the ceiling record when it
   * sends one (a scoped admin cannot otherwise see other global records),
   * else the draft override by id, else the raw id, else the global default.
   */
  const ceilingLabel = (limit: MyLimit): string => {
    if (limit.ceilingLabel) return limit.ceilingLabel;
    if (limit.ceilingOverrideId) {
      const match = overrides.find((o) => o.id === limit.ceilingOverrideId);
      return match?.label || limit.ceilingOverrideId;
    }
    return t('previewSourceGlobal');
  };

  const valueLabel = (limit: MyLimit): string => {
    const def = getLimitDefinition(limit.limitKey);
    if (limit.value === false || limit.value === 0) return t('modeBlocked');
    if (limit.value === null || limit.value === true) {
      return def?.unit === 'boolean' ? t('modeAllowed') : t('modeUnlimited');
    }
    const unit = def ? t(`unit.${def.unit}` as never) : '';
    const window =
      def && (def.window === 'day' || def.window === 'month')
        ? ` / ${t(`window.${def.window}` as never)}`
        : '';
    return `${limit.value} ${unit}${window}`.trim();
  };

  const rowLabel = (limit: MyLimit): string => {
    const def = getLimitDefinition(limit.limitKey);
    const base = def ? t(`label.${def.labelKey}` as never) : limit.limitKey;
    const qualifier = limit.modelId ?? limit.series;
    return qualifier ? `${base} — ${qualifier}` : base;
  };

  /** Counter for this cell: the qualified cell first, then the bare key. */
  const usageFor = (limit: MyLimit): PreviewUsage | undefined => {
    const usage = result?.usage;
    if (!usage) return undefined;
    // Same key the debit path writes (model:<id>.<suffix> / family:…).
    return usage[counterCellName(limit)];
  };

  const showUsageColumn =
    withUsage && result !== null && result.usageUnavailable !== true;

  return (
    <section className={`mb-4 ${ADMIN_CARD}`}>
      <h3 className="mb-1 text-sm font-semibold text-black dark:text-white">
        {t('previewTitle')}
      </h3>
      <p className={`mb-2 ${ADMIN_MUTED}`}>{t('previewDescription')}</p>
      {scopeNote && <p className={`mb-2 ${ADMIN_MUTED}`}>{scopeNote}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <EmailAutocompleteInput
          className={`min-w-[220px] ${ADMIN_FIELD}`}
          value={input}
          onChange={setInput}
          suggest={peopleSuggest}
          suggestionsLabel={tPeople('listLabel')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') check();
          }}
          placeholder={t('previewEmailPlaceholder')}
          aria-label={t('previewEmailLabel')}
        />
        <button
          type="button"
          className={ADMIN_BTN_SECONDARY}
          onClick={check}
          disabled={input.trim().length === 0}
        >
          <IconSearch size={16} />
          {t('previewRun')}
        </button>
        <label className="flex items-center gap-1.5 text-sm text-black dark:text-white">
          <input
            type="checkbox"
            className={ADMIN_CHECKBOX}
            checked={withUsage}
            onChange={(e) => setWithUsage(e.target.checked)}
          />
          {t('previewShowUsage')}
        </label>
      </div>

      {submitted !== null && (
        <div className="mt-3">
          {isLoading ? (
            <p className={ADMIN_MUTED} role="status">
              {t('previewLoading')}
            </p>
          ) : forbidden ? (
            <p className={ADMIN_MUTED}>
              {forbiddenMessage ?? t('previewForbidden')}
            </p>
          ) : error ? (
            <p className={ADMIN_MUTED}>{t('previewFailed')}</p>
          ) : result ? (
            <>
              {dirty && (
                <p className={`mb-2 ${ADMIN_MUTED}`}>{t('previewUnsaved')}</p>
              )}
              {(result.notEvaluated?.length ?? 0) > 0 && (
                <p className={`mb-2 ${ADMIN_MUTED}`}>
                  {t('previewNotEvaluated')}
                </p>
              )}
              {withUsage && result.usageUnavailable && (
                <p className={`mb-2 ${ADMIN_MUTED}`}>
                  {t('previewUsageUnavailable')}
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left dark:border-gray-700">
                      <th className="py-1.5 pr-3 font-medium text-gray-700 dark:text-gray-300">
                        {t('previewColumnLimit')}
                      </th>
                      <th className="py-1.5 pr-3 font-medium text-gray-700 dark:text-gray-300">
                        {t('previewColumnValue')}
                      </th>
                      {showUsageColumn && (
                        <th className="py-1.5 pr-3 font-medium text-gray-700 dark:text-gray-300">
                          {t('previewColumnUsage')}
                        </th>
                      )}
                      <th className="py-1.5 font-medium text-gray-700 dark:text-gray-300">
                        {t('previewColumnSource')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((limit) => (
                      <tr
                        key={`${limit.limitKey}|${limit.modelId ?? ''}|${limit.series ?? ''}`}
                        className="border-b border-gray-100 dark:border-gray-800"
                      >
                        <td className="py-1.5 pr-3 text-black dark:text-white">
                          {rowLabel(limit)}
                        </td>
                        <td className="py-1.5 pr-3 text-black dark:text-white">
                          {valueLabel(limit)}
                        </td>
                        {showUsageColumn && (
                          <td className="py-1.5 pr-3 text-black dark:text-white">
                            <UsageCell limit={limit} usage={usageFor(limit)} />
                          </td>
                        )}
                        <td className={`py-1.5 ${ADMIN_MUTED}`}>
                          <div className="flex flex-wrap items-center gap-1">
                            <span>{sourceLabel(limit)}</span>
                            {limit.tier === 'scoped' && (
                              <span className={ADMIN_CHIP_NEUTRAL}>
                                {t('tierScoped')}
                              </span>
                            )}
                          </div>
                          {limit.ceilingApplied && (
                            <div>
                              {t('previewCeilingPinned', {
                                label: ceilingLabel(limit),
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
};

interface UsageCellProps {
  limit: MyLimit;
  usage: PreviewUsage | undefined;
}

/**
 * "used of limit" with a proportion bar for numeric caps; a bare count for
 * unlimited cells; a dash for booleans and cells the server sent no counter
 * for (a counter that was never touched is legitimately absent).
 */
const UsageCell: FC<UsageCellProps> = ({ limit, usage }) => {
  const t = useTranslations('limits');
  if (!usage || typeof limit.value === 'boolean') {
    return <span aria-hidden="true">—</span>;
  }
  if (limit.value === null) {
    return <span>{t('previewUsageUnlimited', { used: usage.used })}</span>;
  }
  const ratio = limit.value > 0 ? usage.used / limit.value : 1;
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const exhausted = usage.used >= limit.value;
  return (
    <div className="min-w-[120px]">
      <div>{t('previewUsageOf', { used: usage.used, limit: limit.value })}</div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={`h-full ${exhausted ? 'bg-red-600' : 'bg-blue-600'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};
