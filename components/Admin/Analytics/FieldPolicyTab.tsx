'use client';

import { IconAlertTriangle, IconTrash } from '@tabler/icons-react';
import { FC, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  AnalyticsSaveError,
  useAnalyticsFieldPolicyAdmin,
  useAnalyticsHealthAdmin,
} from '@/client/hooks/settings/useAnalyticsAdmin';

import { AnalyticsFieldPolicyAdminResponse } from '@/lib/services/analytics/dto';
import {
  ANALYTICS_FIELD_IDS,
  AnalyticsFieldId,
  isAnalyticsFieldId,
  normalizeColumnName,
} from '@/lib/services/analytics/fields';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_FIELD,
  ADMIN_HEADING,
  ADMIN_HINT,
  ADMIN_MUTED,
  ADMIN_ROW,
} from '@/components/Admin/adminClasses';

/**
 * Which fields of the delivered reports the platform may show.
 *
 * A field is one piece of information wherever it appears — "job title" is a
 * column on the per-user sheets and a value on the summary sheet. Hiding it
 * removes it from everything the app serves, and makes any delivered file
 * that contains it admin-only in its original form (the file itself cannot
 * be edited in place).
 *
 * Global admins edit; delegated analytics admins read, and can hide more per
 * folder.
 */
export const FieldPolicyTab: FC = () => {
  const t = useTranslations('analyticsAdmin');
  const { query, save } = useAnalyticsFieldPolicyAdmin();
  const health = useAnalyticsHealthAdmin().query;
  const [hidden, setHidden] = useState<AnalyticsFieldId[]>([]);
  const [columns, setColumns] = useState<Record<string, AnalyticsFieldId>>({});
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [seededFrom, setSeededFrom] =
    useState<AnalyticsFieldPolicyAdminResponse | null>(null);

  if (query.data && query.data !== seededFrom && !query.data.unavailable) {
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setHidden((query.data.document?.hidden ?? []).filter(isAnalyticsFieldId));
    setColumns(
      Object.fromEntries(
        Object.entries(query.data.document?.columns ?? {}).filter(
          (entry): entry is [string, AnalyticsFieldId] =>
            isAnalyticsFieldId(entry[1]),
        ),
      ),
    );
    setDirty(false);
  }

  const handleSave = async () => {
    try {
      const result = await save.mutateAsync({
        policy: { hidden, columns },
        etag,
      });
      setEtag(result.etag);
      setDirty(false);
      toast.success(t('saveSuccess'));
    } catch (error) {
      if (error instanceof AnalyticsSaveError) {
        if (error.status === 409) {
          toast.error(t('conflictError'));
          await query.refetch();
          return;
        }
        toast.error(
          error.details ? `${error.message}: ${error.details}` : error.message,
        );
        return;
      }
      toast.error(t('saveError'));
    }
  };

  if (query.isLoading) return <p className={ADMIN_MUTED}>{t('loading')}</p>;
  if (query.isError || !query.data) {
    return (
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
    );
  }
  if (query.data.unavailable) {
    return (
      <div className={`${ADMIN_BANNER_WARN} flex items-center gap-3`}>
        <IconAlertTriangle size={18} className="shrink-0" aria-hidden />
        <span className="flex-1">{t('unavailable')}</span>
        <button
          type="button"
          className={ADMIN_BTN_RETRY}
          onClick={() => query.refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  const canEdit = query.data.canEdit;
  // Waiting for a decision: reported by the validator, not yet filed here.
  const waiting = (health.data?.unclassifiedColumns ?? []).filter(
    (entry) => !(normalizeColumnName(entry.column) in columns),
  );

  const classify = (column: string, field: AnalyticsFieldId | '') => {
    const key = normalizeColumnName(column);
    setColumns((previous) => {
      const next = { ...previous };
      if (field === '') delete next[key];
      else next[key] = field;
      return next;
    });
    setDirty(true);
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t('fields.intro')}
      </p>
      {!canEdit && (
        <p className={ADMIN_BANNER_WARN} role="note">
          {t('fields.readOnly')}
        </p>
      )}

      <section>
        <h3 className={ADMIN_HEADING}>{t('fields.configurableHeading')}</h3>
        <ul className="space-y-2">
          {ANALYTICS_FIELD_IDS.map((field) => {
            const shown = !hidden.includes(field);
            return (
              <li key={field} className={ADMIN_ROW}>
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className={`${ADMIN_CHECKBOX} mt-0.5`}
                    checked={shown}
                    disabled={!canEdit}
                    onChange={(e) => {
                      setHidden((previous) =>
                        e.target.checked
                          ? previous.filter((f) => f !== field)
                          : [...previous, field],
                      );
                      setDirty(true);
                    }}
                  />
                  <span>
                    <span className="text-sm font-medium text-black dark:text-white">
                      {t(`field.${field}.label`)}
                    </span>
                    <span className={`${ADMIN_MUTED} block`}>
                      {t(`field.${field}.description`)}
                    </span>
                  </span>
                  <span className={`${ADMIN_MUTED} ml-auto shrink-0`}>
                    {shown ? t('fields.shown') : t('fields.hidden')}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className={ADMIN_HINT}>{t('fields.jobTitleNote')}</p>
      </section>

      <section>
        <h3 className={ADMIN_HEADING}>{t('fields.neverHeading')}</h3>
        <p className={`${ADMIN_CARD} text-sm text-gray-700 dark:text-gray-300`}>
          {t('fields.neverBody')}
        </p>
      </section>

      <section>
        <h3 className={ADMIN_HEADING}>{t('fields.unclassifiedHeading')}</h3>
        <p className="mb-2 text-sm text-gray-700 dark:text-gray-300">
          {t('fields.unclassifiedBody')}
        </p>
        {waiting.length === 0 && Object.keys(columns).length === 0 ? (
          <p className={ADMIN_MUTED}>{t('fields.noneWaiting')}</p>
        ) : (
          <ul className="space-y-2">
            {waiting.map((entry) => (
              <ColumnRow
                key={`waiting-${entry.column}`}
                column={entry.column}
                detail={t('fields.inFiles', { count: entry.files })}
                value=""
                disabled={!canEdit}
                onChange={(field) => classify(entry.column, field)}
              />
            ))}
            {Object.entries(columns).map(([column, field]) => (
              <ColumnRow
                key={`filed-${column}`}
                column={column}
                value={field}
                disabled={!canEdit}
                onChange={(next) => classify(column, next)}
                onRemove={canEdit ? () => classify(column, '') : undefined}
              />
            ))}
          </ul>
        )}
      </section>

      {canEdit && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={ADMIN_BTN_PRIMARY}
            disabled={!dirty || save.isPending}
            onClick={handleSave}
          >
            {save.isPending ? t('saving') : t('save')}
          </button>
          {dirty && <span className={ADMIN_MUTED}>{t('unsaved')}</span>}
        </div>
      )}
    </div>
  );
};

const ColumnRow: FC<{
  column: string;
  detail?: string;
  value: AnalyticsFieldId | '';
  disabled: boolean;
  onChange: (field: AnalyticsFieldId | '') => void;
  onRemove?: () => void;
}> = ({ column, detail, value, disabled, onChange, onRemove }) => {
  const t = useTranslations('analyticsAdmin');
  return (
    <li className={`${ADMIN_ROW} flex flex-wrap items-center gap-3`}>
      <span className="min-w-0 flex-1">
        <span className="break-all font-mono text-xs text-black dark:text-white">
          {column}
        </span>
        {detail && <span className={`${ADMIN_MUTED} ml-2`}>{detail}</span>}
      </span>
      <select
        aria-label={t('fields.classifyAs', { column })}
        className={`${ADMIN_FIELD} w-56`}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as AnalyticsFieldId | '')}
      >
        <option value="">{t('fields.keepHidden')}</option>
        {ANALYTICS_FIELD_IDS.map((field) => (
          <option key={field} value={field}>
            {t(`field.${field}.label`)}
          </option>
        ))}
      </select>
      {onRemove && (
        <button
          type="button"
          className={ADMIN_BTN_ICON_DANGER}
          aria-label={t('fields.removeClassification', { column })}
          onClick={onRemove}
        >
          <IconTrash size={16} />
        </button>
      )}
    </li>
  );
};
