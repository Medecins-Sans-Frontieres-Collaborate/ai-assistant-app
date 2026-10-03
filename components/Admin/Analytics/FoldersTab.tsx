'use client';

import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import {
  AnalyticsSaveError,
  useAnalyticsFieldPolicyAdmin,
  useAnalyticsFoldersAdmin,
} from '@/client/hooks/settings/useAnalyticsAdmin';

import { indexFolders } from '@/lib/services/analytics/access';
import { AnalyticsFoldersAdminResponse } from '@/lib/services/analytics/dto';
import {
  ANALYTICS_FIELD_IDS,
  AnalyticsFieldId,
  isAnalyticsFieldId,
} from '@/lib/services/analytics/fields';
import {
  folderChain,
  isRawPath,
  isSafeRelativePath,
  normalizeFolderPath,
  parentFolder,
} from '@/lib/services/analytics/paths';
import { effectiveReportType } from '@/lib/services/analytics/reportTypes';
import { effectiveRetentionMonths } from '@/lib/services/analytics/retention';
import {
  ANALYTICS_ACCESS_LEVELS,
  ANALYTICS_REPORT_TYPE_IDS,
  AnalyticsAccessLevel,
  AnalyticsFolder,
  AnalyticsReportTypeId,
  DEFAULT_RETENTION_MONTHS,
  MAX_RETENTION_MONTHS,
} from '@/lib/services/analytics/types';
import { WriteAnalyticsFolder } from '@/lib/services/analytics/writeSchema';
import { JurisdictionPredicate } from '@/lib/services/limits/types';

import {
  targetsToText,
  textToTargets,
} from '@/components/Admin/Delegations/PredicateListEditor';
import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_ICON_DANGER,
  ADMIN_BTN_PRIMARY,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CARD,
  ADMIN_CHECKBOX,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_FIELD,
  ADMIN_HINT,
  ADMIN_LABEL,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { folderDepth } from '@/components/Analytics/format';

type Scope = JurisdictionPredicate['scope'];
const SCOPES: Scope[] = ['group', 'domain', 'user', 'attribute'];

interface AudienceDraft {
  scope: Scope;
  /** Raw text, so typing a separator does not fight the cursor. */
  text: string;
  level: AnalyticsAccessLevel;
}

interface FolderDraft {
  path: string;
  name: string;
  description: string;
  reportType: AnalyticsReportTypeId | '';
  audience: AudienceDraft[];
  restricted: boolean;
  /** '' = inherit. */
  retentionMonths: string;
  hiddenFields: AnalyticsFieldId[];
}

function emptyDraft(path: string): FolderDraft {
  return {
    path,
    name: '',
    description: '',
    reportType: '',
    audience: [],
    restricted: false,
    retentionMonths: '',
    hiddenFields: [],
  };
}

function toDraft(folder: AnalyticsFolder): FolderDraft {
  return {
    path: folder.path,
    name: folder.name,
    description: folder.description,
    reportType: folder.reportType ?? '',
    audience: folder.audience.map((entry) => ({
      scope: entry.scope,
      text: targetsToText(entry.targets),
      level: entry.level,
    })),
    restricted: folder.restricted,
    retentionMonths:
      folder.retentionMonths === null ? '' : String(folder.retentionMonths),
    hiddenFields: folder.hiddenFields.filter(isAnalyticsFieldId),
  };
}

function toWrite(draft: FolderDraft): WriteAnalyticsFolder {
  const months = Number.parseInt(draft.retentionMonths, 10);
  const raw = isRawPath(draft.path);
  return {
    path: draft.path,
    name: draft.name.trim(),
    description: draft.description.trim(),
    reportType: draft.reportType === '' ? null : draft.reportType,
    audience: raw
      ? []
      : draft.audience
          .map((entry) => ({
            scope: entry.scope,
            targets: textToTargets(entry.text),
            level: entry.level,
          }))
          .filter((entry) => entry.targets.length > 0),
    restricted: draft.restricted,
    retentionMonths: Number.isFinite(months) ? months : null,
    hiddenFields: raw ? [] : draft.hiddenFields,
  };
}

/** What the evaluators see for the drafts as they stand (unsaved included). */
function draftIndex(drafts: Record<string, FolderDraft>) {
  return indexFolders(Object.values(drafts).map(toWrite));
}

/**
 * The folder overlay: one row per folder of the delivery container, opened to
 * edit how it is presented, who may open it, and how long its files are kept.
 *
 * The folders themselves are whatever the ETL wrote; this page cannot create
 * or delete one. "Add a path" only saves settings ahead of the first delivery.
 *
 * One document, one CAS'd PUT. A folder with no saved settings — and no
 * ancestor granting access — is visible to admins only.
 */
export const FoldersTab: FC = () => {
  const t = useTranslations('analyticsAdmin');
  const { query, save } = useAnalyticsFoldersAdmin();
  const policy = useAnalyticsFieldPolicyAdmin().query;
  const [drafts, setDrafts] = useState<Record<string, FolderDraft>>({});
  const [extraPaths, setExtraPaths] = useState<string[]>([]);
  const [etag, setEtag] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [newPath, setNewPath] = useState('');
  const [seededFrom, setSeededFrom] =
    useState<AnalyticsFoldersAdminResponse | null>(null);

  if (query.data && query.data !== seededFrom && !query.data.unavailable) {
    setSeededFrom(query.data);
    setEtag(query.data.etag);
    setDrafts(
      Object.fromEntries(
        (query.data.document?.folders ?? []).map((folder) => [
          folder.path,
          toDraft(folder),
        ]),
      ),
    );
    setExtraPaths([]);
    setDirty(false);
  }

  const paths = useMemo(() => {
    const all = new Set<string>(query.data?.paths ?? ['']);
    for (const path of [...Object.keys(drafts), ...extraPaths]) {
      for (const ancestor of folderChain(path)) all.add(ancestor);
    }
    return [...all].sort((a, b) => a.localeCompare(b));
  }, [query.data, drafts, extraPaths]);

  const index = useMemo(() => draftIndex(drafts), [drafts]);
  const platformHidden = useMemo(
    () => new Set(policy.data?.document?.hidden ?? []),
    [policy.data],
  );

  const patch = (path: string, change: Partial<FolderDraft>) => {
    setDrafts((previous) => ({
      ...previous,
      [path]: { ...(previous[path] ?? emptyDraft(path)), ...change },
    }));
    setDirty(true);
  };

  const clear = (path: string) => {
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[path];
      return next;
    });
    setDirty(true);
  };

  const addPath = () => {
    const path = normalizeFolderPath(newPath);
    if (path === '' || !isSafeRelativePath(path)) {
      toast.error(t('folders.invalidPath'));
      return;
    }
    if (isRawPath(path) && !query.data?.isGlobalAdmin) {
      toast.error(t('folders.rawGlobalOnly'));
      return;
    }
    setExtraPaths((previous) => [...previous, path]);
    setOpen(path);
    setNewPath('');
  };

  const handleSave = async () => {
    try {
      const result = await save.mutateAsync({
        folders: Object.values(drafts).map(toWrite),
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

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {t('folders.intro')}
      </p>

      <ul className="space-y-2">
        {paths.map((path) => {
          const draft = drafts[path];
          const isOpen = open === path;
          const raw = isRawPath(path);
          const parent = parentFolder(path);
          const Chevron = isOpen ? IconChevronDown : IconChevronRight;
          const audienceCount =
            draft?.audience.filter(
              (entry) => textToTargets(entry.text).length > 0,
            ).length ?? 0;
          return (
            <li key={path} className={ADMIN_CARD}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : path)}
                className="flex w-full flex-wrap items-center gap-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                style={{ paddingLeft: `${folderDepth(path) * 14}px` }}
              >
                <Chevron
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-gray-500 dark:text-gray-400"
                />
                <span className="min-w-0 break-all font-mono text-sm text-black dark:text-white">
                  {path || t('rootFolder')}
                </span>
                {draft?.name && (
                  <span className={ADMIN_MUTED}>{draft.name}</span>
                )}
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  {raw && (
                    <span className={ADMIN_CHIP_WARN}>
                      {t('folders.rawChip')}
                    </span>
                  )}
                  {!raw && audienceCount > 0 && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {t('folders.audienceChip', { count: audienceCount })}
                    </span>
                  )}
                  {draft?.restricted && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {t('folders.restrictedChip')}
                    </span>
                  )}
                  {!draft && (
                    <span className={ADMIN_CHIP_NEUTRAL}>
                      {t('folders.notConfiguredChip')}
                    </span>
                  )}
                </span>
              </button>

              {isOpen && (
                <FolderEditor
                  draft={draft ?? emptyDraft(path)}
                  configured={draft !== undefined}
                  inheritedRetention={
                    parent === null
                      ? DEFAULT_RETENTION_MONTHS
                      : effectiveRetentionMonths(parent, index)
                  }
                  inheritedReportType={
                    parent === null
                      ? null
                      : (effectiveReportType(parent, index)?.id ?? null)
                  }
                  platformHidden={platformHidden}
                  onPatch={(change) => patch(path, change)}
                  onClear={() => clear(path)}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className={`${ADMIN_CARD} space-y-2`}>
        <label htmlFor="analytics-new-path" className={ADMIN_LABEL}>
          {t('folders.addPathLabel')}
        </label>
        <div className="flex gap-2">
          <input
            id="analytics-new-path"
            className={`${ADMIN_FIELD} min-w-0 flex-1 font-mono`}
            value={newPath}
            placeholder="usage/ocba"
            maxLength={400}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPath();
            }}
          />
          <button
            type="button"
            className={ADMIN_BTN_SECONDARY}
            onClick={addPath}
          >
            <IconPlus size={16} aria-hidden="true" />
            {t('folders.addPath')}
          </button>
        </div>
        <p className={ADMIN_HINT}>{t('folders.addPathHint')}</p>
      </div>

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
    </div>
  );
};

interface FolderEditorProps {
  draft: FolderDraft;
  configured: boolean;
  inheritedRetention: number;
  inheritedReportType: AnalyticsReportTypeId | null;
  platformHidden: ReadonlySet<string>;
  onPatch: (change: Partial<FolderDraft>) => void;
  onClear: () => void;
}

const FolderEditor: FC<FolderEditorProps> = ({
  draft,
  configured,
  inheritedRetention,
  inheritedReportType,
  platformHidden,
  onPatch,
  onClear,
}) => {
  const t = useTranslations('analyticsAdmin');
  const raw = isRawPath(draft.path);
  const idBase = `analytics-folder-${draft.path.replace(/[^a-z0-9]/gi, '-')}`;
  // Raw folders hold raw telemetry or nothing; raw telemetry lives nowhere else.
  const reportTypes = ANALYTICS_REPORT_TYPE_IDS.filter(
    (id) => (id === 'raw-telemetry') === raw,
  );

  const patchAudience = (
    indexToPatch: number,
    change: Partial<AudienceDraft>,
  ) =>
    onPatch({
      audience: draft.audience.map((entry, i) =>
        i === indexToPatch ? { ...entry, ...change } : entry,
      ),
    });

  return (
    <div className="mt-4 space-y-4 border-t border-gray-200 pt-4 dark:border-gray-700">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={`${idBase}-name`} className={ADMIN_LABEL}>
            {t('folders.name')}
          </label>
          <input
            id={`${idBase}-name`}
            className={`${ADMIN_FIELD} w-full`}
            value={draft.name}
            maxLength={120}
            placeholder={t('folders.namePlaceholder')}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${idBase}-type`} className={ADMIN_LABEL}>
            {t('folders.reportType')}
          </label>
          <select
            id={`${idBase}-type`}
            className={`${ADMIN_FIELD} w-full`}
            value={draft.reportType}
            onChange={(e) =>
              onPatch({
                reportType: e.target.value as FolderDraft['reportType'],
              })
            }
          >
            <option value="">
              {inheritedReportType
                ? t('folders.reportTypeInherited', {
                    type: t(`reportType.${inheritedReportType}`),
                  })
                : t('folders.reportTypeNone')}
            </option>
            {reportTypes.map((id) => (
              <option key={id} value={id}>
                {t(`reportType.${id}`)}
              </option>
            ))}
          </select>
          <p className={ADMIN_HINT}>{t('folders.reportTypeHint')}</p>
        </div>
      </div>

      <div>
        <label htmlFor={`${idBase}-description`} className={ADMIN_LABEL}>
          {t('folders.description')}
        </label>
        <textarea
          id={`${idBase}-description`}
          className={`${ADMIN_FIELD} w-full`}
          rows={2}
          maxLength={500}
          value={draft.description}
          onChange={(e) => onPatch({ description: e.target.value })}
        />
      </div>

      <div>
        <label htmlFor={`${idBase}-retention`} className={ADMIN_LABEL}>
          {t('folders.retention')}
        </label>
        <input
          id={`${idBase}-retention`}
          type="number"
          min={1}
          max={MAX_RETENTION_MONTHS}
          className={`${ADMIN_FIELD} w-32`}
          value={draft.retentionMonths}
          placeholder={String(inheritedRetention)}
          onChange={(e) => onPatch({ retentionMonths: e.target.value })}
        />
        <p className={ADMIN_HINT}>
          {t('folders.retentionHint', { months: inheritedRetention })}
        </p>
      </div>

      {raw ? (
        <p className={ADMIN_BANNER_WARN} role="note">
          {t('folders.rawNote')}
        </p>
      ) : (
        <>
          <div>
            <p className={ADMIN_LABEL}>{t('folders.audience')}</p>
            <p className={ADMIN_HINT}>{t('folders.audienceHint')}</p>
            <div className="mt-2 space-y-2">
              {draft.audience.map((entry, i) => (
                <div key={i} className="flex flex-wrap items-start gap-2">
                  <select
                    aria-label={t('folders.audienceScope')}
                    className={`${ADMIN_FIELD} w-36 shrink-0`}
                    value={entry.scope}
                    onChange={(e) =>
                      patchAudience(i, { scope: e.target.value as Scope })
                    }
                  >
                    {SCOPES.map((scope) => (
                      <option key={scope} value={scope}>
                        {t(`scope.${scope}`)}
                      </option>
                    ))}
                  </select>
                  <textarea
                    aria-label={t('folders.audienceTargets')}
                    className={`${ADMIN_FIELD} min-w-0 flex-1 font-mono text-xs`}
                    rows={2}
                    value={entry.text}
                    placeholder={t(`scopePlaceholder.${entry.scope}`)}
                    onChange={(e) => patchAudience(i, { text: e.target.value })}
                  />
                  <select
                    aria-label={t('folders.audienceLevel')}
                    className={`${ADMIN_FIELD} w-40 shrink-0`}
                    value={entry.level}
                    onChange={(e) =>
                      patchAudience(i, {
                        level: e.target.value as AnalyticsAccessLevel,
                      })
                    }
                  >
                    {ANALYTICS_ACCESS_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`level.${level}`)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={ADMIN_BTN_ICON_DANGER}
                    aria-label={t('folders.removeAudience')}
                    onClick={() =>
                      onPatch({
                        audience: draft.audience.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <IconTrash size={16} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={ADMIN_BTN_SECONDARY}
                onClick={() =>
                  onPatch({
                    audience: [
                      ...draft.audience,
                      { scope: 'group', text: '', level: 'download' },
                    ],
                  })
                }
              >
                <IconPlus size={16} aria-hidden="true" />
                {t('folders.addAudience')}
              </button>
            </div>
            <label className="mt-3 flex items-start gap-2 text-sm text-black dark:text-white">
              <input
                type="checkbox"
                className={`${ADMIN_CHECKBOX} mt-0.5`}
                checked={draft.restricted}
                onChange={(e) => onPatch({ restricted: e.target.checked })}
              />
              <span>
                {t('folders.restricted')}
                <span className={`${ADMIN_MUTED} block`}>
                  {t('folders.restrictedHint')}
                </span>
              </span>
            </label>
          </div>

          <fieldset>
            <legend className={ADMIN_LABEL}>{t('folders.hiddenFields')}</legend>
            <p className={ADMIN_HINT}>{t('folders.hiddenFieldsHint')}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {ANALYTICS_FIELD_IDS.map((field) => {
                const platform = platformHidden.has(field);
                return (
                  <label
                    key={field}
                    className="flex items-center gap-2 text-sm text-black dark:text-white"
                  >
                    <input
                      type="checkbox"
                      className={ADMIN_CHECKBOX}
                      checked={platform || draft.hiddenFields.includes(field)}
                      disabled={platform}
                      onChange={(e) =>
                        onPatch({
                          hiddenFields: e.target.checked
                            ? [...draft.hiddenFields, field]
                            : draft.hiddenFields.filter((f) => f !== field),
                        })
                      }
                    />
                    {t(`field.${field}.label`)}
                    {platform && (
                      <span className={ADMIN_MUTED}>
                        {t('folders.hiddenPlatformWide')}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </>
      )}

      {configured && (
        <button type="button" className={ADMIN_BTN_SECONDARY} onClick={onClear}>
          <IconTrash size={16} aria-hidden="true" />
          {t('folders.clear')}
        </button>
      )}
    </div>
  );
};
