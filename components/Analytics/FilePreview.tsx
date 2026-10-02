'use client';

import {
  IconArrowLeft,
  IconChartBar,
  IconDownload,
  IconLock,
  IconTable,
} from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  analyticsDownloadUrl,
  analyticsExportUrl,
  useAnalyticsPreview,
  useAnalyticsTable,
} from '@/client/hooks/analytics/useAnalytics';

import { AnalyticsFileDto } from '@/lib/services/analytics/dto';
import { TableSummary } from '@/lib/services/analytics/previewModel';

import { AdminTabs } from '@/components/Admin/AdminTabs';
import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_FIELD,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { PreviewGrid, filterRows } from '@/components/Analytics/PreviewGrid';
import { QuickChart } from '@/components/Analytics/QuickChart';
import { DashboardView } from '@/components/Analytics/dashboards/DashboardView';

const ID_PREFIX = 'analytics-preview';

interface FilePreviewProps {
  file: AnalyticsFileDto;
  folderLabel: string;
  onBack: () => void;
}

/**
 * One delivered file, opened in the app: a tab per table, a grid, and a
 * chart built from whichever table is open.
 *
 * What is shown was filtered on the server for this person. A table they may
 * not open still has its tab — locked, with the reason — so the file's shape
 * is not a mystery.
 */
export const FilePreview: FC<FilePreviewProps> = ({
  file,
  folderLabel,
  onBack,
}) => {
  const t = useTranslations('analytics');
  const preview = useAnalyticsPreview(file.canPreview ? file.id : null);
  const [chosen, setChosen] = useState<string | null>(null);
  // The overview is where a file opens when it has one: most readers want
  // the figures, not the sheets.
  const [section, setSection] = useState<'overview' | 'tables'>(
    file.canViewDashboard ? 'overview' : 'tables',
  );
  const showOverview = file.canViewDashboard && section === 'overview';

  const tables = useMemo(() => preview.data?.tables ?? [], [preview.data]);
  const active =
    tables.find((table) => table.name === chosen) ??
    tables.find((table) => table.withheld === null) ??
    tables[0];
  const activeIndex = active ? tables.indexOf(active) : -1;

  return (
    <section aria-labelledby={`${ID_PREFIX}-title`} className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-white"
      >
        <IconArrowLeft size={16} aria-hidden="true" />
        {t('preview.back', { folder: folderLabel })}
      </button>

      <div className="flex flex-wrap items-start gap-3">
        <h2
          id={`${ID_PREFIX}-title`}
          className="min-w-0 flex-1 break-all text-lg font-semibold text-black dark:text-white"
        >
          {file.name}
        </h2>
        <div className="flex flex-wrap gap-2">
          {!showOverview &&
            preview.data?.canExport &&
            active &&
            active.withheld === null && (
              <a
                href={analyticsExportUrl(file.id, 'csv', active.name)}
                download
                className={ADMIN_BTN_SECONDARY}
              >
                <IconDownload size={16} aria-hidden="true" />
                {t('preview.exportCsv')}
              </a>
            )}
          {preview.data?.canExport && (
            <a
              href={analyticsExportUrl(file.id, 'xlsx')}
              download
              className={ADMIN_BTN_SECONDARY}
            >
              <IconDownload size={16} aria-hidden="true" />
              {t('preview.exportXlsx')}
            </a>
          )}
          {file.canDownload && (
            <a
              href={analyticsDownloadUrl(file.id)}
              download={file.name}
              className={ADMIN_BTN_SECONDARY}
            >
              <IconDownload size={16} aria-hidden="true" />
              {t('preview.downloadOriginal')}
            </a>
          )}
        </div>
      </div>

      {preview.data?.canExport && !file.canDownload && (
        <p className={ADMIN_BANNER_WARN} role="note">
          {t('preview.exportNote')}
        </p>
      )}

      {file.canViewDashboard && file.canPreview && (
        <div
          role="group"
          aria-label={t('preview.sectionLabel')}
          className="flex gap-1"
        >
          {(['overview', 'tables'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={section === option}
              onClick={() => setSection(option)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                section === option
                  ? 'bg-gray-100 text-black dark:bg-gray-800 dark:text-white'
                  : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60'
              }`}
            >
              {t(`preview.section.${option}`)}
            </button>
          ))}
        </div>
      )}

      {showOverview ? (
        <DashboardView fileId={file.id} />
      ) : preview.isLoading ? (
        <p className={ADMIN_MUTED}>{t('loading')}</p>
      ) : preview.isError || !active ? (
        <div className={ADMIN_BANNER_ERROR} role="alert">
          <p>{t('preview.unavailable')}</p>
          <button
            type="button"
            className={`${ADMIN_BTN_RETRY} mt-2`}
            onClick={() => preview.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      ) : (
        <>
          {/* Ids are positions, not sheet names: a name with a space in it
              is not a valid element id, and `aria-controls` would read it as
              two. */}
          <AdminTabs
            tabs={tables.map((table, index) => ({
              id: String(index),
              label: table.withheld
                ? t('preview.lockedTab', { name: table.name })
                : table.name,
            }))}
            activeTab={String(activeIndex)}
            onChange={(id) => setChosen(tables[Number(id)]?.name ?? null)}
            idPrefix={ID_PREFIX}
            ariaLabel={t('preview.tabsLabel')}
          />
          <div
            role="tabpanel"
            id={`${ID_PREFIX}-panel-${activeIndex}`}
            aria-labelledby={`${ID_PREFIX}-tab-${activeIndex}`}
          >
            {active.withheld ? (
              <div className={`${ADMIN_BANNER_WARN} flex items-start gap-2`}>
                <IconLock
                  size={18}
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                />
                <span>{t(`preview.withheld.${active.withheld}`)}</span>
              </div>
            ) : (
              // Keyed by table: the filter, sort and chart choices of one
              // table mean nothing on the next.
              <TableBody key={active.name} fileId={file.id} summary={active} />
            )}
          </div>
        </>
      )}
    </section>
  );
};

const TableBody: FC<{ fileId: string; summary: TableSummary }> = ({
  fileId,
  summary,
}) => {
  const t = useTranslations('analytics');
  const table = useAnalyticsTable(fileId, summary.name);
  const [needle, setNeedle] = useState('');
  const [mode, setMode] = useState<'table' | 'chart'>('table');

  const rows = useMemo(
    () => filterRows(table.data?.rows ?? [], needle),
    [table.data, needle],
  );

  if (table.isLoading) return <p className={ADMIN_MUTED}>{t('loading')}</p>;
  if (table.isError || !table.data) {
    return (
      <div className={ADMIN_BANNER_ERROR} role="alert">
        <p>{t('preview.tableFailed')}</p>
        <button
          type="button"
          className={`${ADMIN_BTN_RETRY} mt-2`}
          onClick={() => table.refetch()}
        >
          {t('retry')}
        </button>
      </div>
    );
  }

  const freeform = table.data.layout === 'freeform';
  const loaded = table.data.rows.length;
  const partial = table.data.truncated
    ? { shown: loaded, total: table.data.rowCount }
    : null;

  return (
    <div className="space-y-3">
      {partial && (
        <p className={ADMIN_BANNER_WARN} role="note">
          {t('preview.truncated', partial)}
        </p>
      )}
      {freeform && <p className={ADMIN_MUTED}>{t('preview.freeformNote')}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          aria-label={t('preview.filter')}
          placeholder={t('preview.filterPlaceholder')}
          className={`${ADMIN_FIELD} w-64`}
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
        />
        <span className={ADMIN_MUTED}>
          {needle.trim() === ''
            ? t('preview.rows', { count: loaded })
            : t('preview.matching', { count: rows.length, total: loaded })}
        </span>
        {!freeform && (
          <div
            role="group"
            aria-label={t('preview.modeLabel')}
            className="ml-auto flex gap-1"
          >
            {(['table', 'chart'] as const).map((option) => {
              const Icon = option === 'table' ? IconTable : IconChartBar;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={mode === option}
                  onClick={() => setMode(option)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    mode === option
                      ? 'bg-gray-100 text-black dark:bg-gray-800 dark:text-white'
                      : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60'
                  }`}
                >
                  <Icon size={16} aria-hidden="true" />
                  {t(`preview.mode.${option}`)}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {mode === 'chart' && !freeform ? (
        <QuickChart
          tableName={summary.name}
          columns={table.data.columns}
          rows={rows}
          partial={partial}
        />
      ) : rows.length === 0 ? (
        <p className={ADMIN_MUTED}>{t('preview.noRows')}</p>
      ) : (
        <PreviewGrid
          columns={table.data.columns}
          rows={rows}
          freeform={freeform}
          ariaLabel={summary.name}
        />
      )}
    </div>
  );
};
