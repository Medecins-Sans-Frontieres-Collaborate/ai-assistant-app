'use client';

import { IconSearch } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  MyLimit,
  useEffectiveLimitsPreview,
} from '@/client/hooks/settings/useLimitsAdmin';
import { useM365PeopleSuggest } from '@/client/hooks/useM365PeopleSuggest';

import { LimitOverride } from '@/lib/services/limits/types';

import {
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
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
 * against the SAVED policy via the admin-only `/api/limits/me?as=` preview,
 * and names the winning layer for every key — the answer to "which override
 * wins" that the editor cards alone cannot give.
 */
export const EffectiveLimitsPreview: FC<EffectiveLimitsPreviewProps> = ({
  overrides,
  dirty,
}) => {
  const t = useTranslations('limits');
  const tPeople = useTranslations('peopleSuggest');
  const peopleSuggest = useM365PeopleSuggest();
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const { result, forbidden, isLoading, error } =
    useEffectiveLimitsPreview(submitted);

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

  return (
    <section className={`mb-4 ${ADMIN_CARD}`}>
      <h3 className="mb-1 text-sm font-semibold text-black dark:text-white">
        {t('previewTitle')}
      </h3>
      <p className={`mb-2 ${ADMIN_MUTED}`}>{t('previewDescription')}</p>
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
      </div>

      {submitted !== null && (
        <div className="mt-3">
          {isLoading ? (
            <p className={ADMIN_MUTED} role="status">
              {t('previewLoading')}
            </p>
          ) : forbidden ? (
            <p className={ADMIN_MUTED}>{t('previewForbidden')}</p>
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
                        <td className={`py-1.5 ${ADMIN_MUTED}`}>
                          {sourceLabel(limit)}
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
