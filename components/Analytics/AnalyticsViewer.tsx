'use client';

import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChartBar,
  IconDownload,
  IconFolder,
  IconFolderOpen,
  IconSettings,
} from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import {
  analyticsDownloadUrl,
  useAnalyticsEnabled,
  useAnalyticsFiles,
  useAnalyticsTree,
} from '@/client/hooks/analytics/useAnalytics';

import { AnalyticsFileDto } from '@/lib/services/analytics/dto';
import { FolderView } from '@/lib/services/analytics/viewModel';

import { formatBytes } from '@/lib/utils/app/storage/storageUtils';

import {
  ADMIN_BANNER_ERROR,
  ADMIN_BANNER_WARN,
  ADMIN_BTN_RETRY,
  ADMIN_BTN_SECONDARY,
  ADMIN_CHIP_DANGER,
  ADMIN_CHIP_NEUTRAL,
  ADMIN_CHIP_WARN,
  ADMIN_MUTED,
} from '@/components/Admin/adminClasses';
import { FilePreview } from '@/components/Analytics/FilePreview';
import { TrendPanel } from '@/components/Analytics/dashboards/TrendPanel';
import {
  folderDepth,
  folderLabel,
  formatDay,
  formatPeriod,
} from '@/components/Analytics/format';

import { Link } from '@/lib/navigation';

/**
 * /analytics — the delivered reports a person has been given access to.
 *
 * A full-page surface like the admin area (ChatShell drops the conversation
 * sidebar for it). The tree on the left holds only what the server says this
 * person may open; a folder they were not granted is simply absent.
 *
 * A file opens in place: its tables, a grid, a quick chart, and exports with
 * hidden fields removed. At `view` level that covers the aggregate tables;
 * per-person tables and downloads need `download` access, and the file list
 * says so rather than offering a dead link.
 */
export const AnalyticsViewer: FC = () => {
  const t = useTranslations('analytics');
  const enabled = useAnalyticsEnabled();
  const tree = useAnalyticsTree(enabled);
  const [selected, setSelected] = useState<string | null>(null);

  const folders = useMemo(() => tree.data?.folders ?? [], [tree.data]);
  // Until the person picks one: the first folder that actually holds files,
  // else the first they can open.
  const active = useMemo(() => {
    if (selected !== null && folders.some((f) => f.path === selected)) {
      return selected;
    }
    const openable = folders.filter((folder) => !folder.pathOnly);
    return (
      (openable.find((folder) => folder.fileCount > 0) ?? openable[0])?.path ??
      null
    );
  }, [folders, selected]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-white dark:bg-surface-dark-base">
      <header className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-gray-500 transition-colors hover:text-black focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-white"
        >
          <IconArrowLeft size={16} />
          {t('backToChat')}
        </Link>
        <span
          aria-hidden="true"
          className="h-4 w-px bg-gray-200 dark:bg-gray-700"
        />
        <IconChartBar size={20} className="text-black dark:text-white" />
        <h1 className="text-sm font-semibold text-black dark:text-white">
          {t('title')}
        </h1>
        {tree.data?.canAdmin && (
          <Link
            href="/admin/analytics"
            className={`${ADMIN_BTN_SECONDARY} ml-auto`}
          >
            <IconSettings size={16} aria-hidden="true" />
            {t('manage')}
          </Link>
        )}
      </header>

      {!enabled ? (
        <CenteredNote title={t('notEnabled')} />
      ) : tree.isLoading ? (
        <CenteredNote title={t('loading')} />
      ) : tree.isError ? (
        <div className="mx-auto mt-10 max-w-md px-4">
          <div className={ADMIN_BANNER_ERROR} role="alert">
            <p>{t('loadFailed')}</p>
            <button
              type="button"
              className={`${ADMIN_BTN_RETRY} mt-2`}
              onClick={() => tree.refetch()}
            >
              {t('retry')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <FolderTree
            folders={folders}
            active={active}
            onSelect={setSelected}
          />
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-5xl space-y-4 p-6">
              {tree.data?.deliveryUnavailable && (
                <div className={ADMIN_BANNER_WARN} role="status">
                  {t('deliveryUnavailable')}
                </div>
              )}
              {tree.data?.groupsDegraded && (
                <div className={ADMIN_BANNER_WARN} role="status">
                  {t('groupsDegraded')}
                </div>
              )}
              {folders.length === 0 ? (
                <CenteredNote
                  title={t('emptyTitle')}
                  body={t('emptyBody')}
                  inline
                />
              ) : active === null ? (
                <p className={ADMIN_MUTED}>{t('selectFolder')}</p>
              ) : (
                <FolderContents
                  folder={folders.find((f) => f.path === active)!}
                />
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
};

const CenteredNote: FC<{ title: string; body?: string; inline?: boolean }> = ({
  title,
  body,
  inline = false,
}) => (
  <div
    className={
      inline
        ? 'py-16 text-center'
        : 'flex flex-1 items-center justify-center p-6 text-center'
    }
  >
    <div>
      <p className="text-sm font-medium text-black dark:text-white">{title}</p>
      {body && <p className={`${ADMIN_MUTED} mt-1`}>{body}</p>}
    </div>
  </div>
);

const FolderTree: FC<{
  folders: FolderView[];
  active: string | null;
  onSelect: (path: string) => void;
}> = ({ folders, active, onSelect }) => {
  const t = useTranslations('analytics');
  if (folders.length === 0) return null;
  // The root is the container, not a folder anyone thinks of opening: show
  // it only when files actually sit there.
  const rows = folders.filter(
    (folder) => folder.path !== '' || folder.fileCount > 0,
  );
  const shift = rows.some((folder) => folder.path === '') ? 0 : 1;

  return (
    <nav
      aria-label={t('foldersHeading')}
      className="max-h-56 shrink-0 overflow-y-auto border-b border-gray-200 p-3 dark:border-gray-700 md:max-h-none md:w-72 md:border-b-0 md:border-r"
    >
      <ul className="space-y-0.5">
        {rows.map((folder) => {
          const isActive = folder.path === active;
          const indent = Math.max(0, folderDepth(folder.path) - shift);
          const label =
            folder.name || folderLabel(folder.path, t('rootFolder'));
          const Icon = isActive ? IconFolderOpen : IconFolder;
          return (
            <li key={folder.path} style={{ paddingLeft: `${indent * 14}px` }}>
              {folder.pathOnly ? (
                <span
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-gray-500 dark:text-gray-400"
                  title={t('pathOnly')}
                >
                  <IconFolder size={16} aria-hidden="true" />
                  <span className="truncate">{label}</span>
                </span>
              ) : (
                <button
                  type="button"
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => onSelect(folder.path)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    isActive
                      ? 'bg-gray-100 font-medium text-black dark:bg-gray-800 dark:text-white'
                      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800/60'
                  }`}
                >
                  <Icon size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {folder.fileCount > 0 && (
                    <span className={ADMIN_MUTED}>{folder.fileCount}</span>
                  )}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
};

const FolderContents: FC<{ folder: FolderView }> = ({ folder }) => {
  const t = useTranslations('analytics');
  const files = useAnalyticsFiles(folder.path);
  const title = folder.name || folderLabel(folder.path, t('rootFolder'));
  const [openId, setOpenId] = useState<string | null>(null);
  // Resolved against the current listing, so a file that was replaced or
  // expired while open closes itself instead of showing a stale preview.
  const openFile = files.data?.files.find((file) => file.id === openId);

  if (openFile) {
    return (
      <FilePreview
        file={openFile}
        folderLabel={title}
        onBack={() => setOpenId(null)}
      />
    );
  }

  return (
    <section aria-labelledby="analytics-folder-title" className="space-y-4">
      <div>
        <h2
          id="analytics-folder-title"
          className="text-lg font-semibold text-black dark:text-white"
        >
          {title}
        </h2>
        {folder.path !== '' && (
          <p className={`${ADMIN_MUTED} font-mono`}>{folder.path}</p>
        )}
        {folder.description && (
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            {folder.description}
          </p>
        )}
      </div>

      {folder.access === 'view' && (
        <div className={ADMIN_BANNER_WARN} role="note">
          {t('viewOnlyNote')}
        </div>
      )}

      {files.isLoading ? (
        <p className={ADMIN_MUTED}>{t('loading')}</p>
      ) : files.isError ? (
        <div className={ADMIN_BANNER_ERROR} role="alert">
          <p>{t('loadFailed')}</p>
          <button
            type="button"
            className={`${ADMIN_BTN_RETRY} mt-2`}
            onClick={() => files.refetch()}
          >
            {t('retry')}
          </button>
        </div>
      ) : (files.data?.files.length ?? 0) === 0 ? (
        <p className={ADMIN_MUTED}>{t('noFiles')}</p>
      ) : (
        <FileTable files={files.data!.files} onOpen={setOpenId} />
      )}

      {/* Asked for the folder's whole subtree, so it can appear on a folder
          that holds only year folders. Renders nothing unless the reports
          under here form one run. */}
      {!files.isLoading && !files.isError && (
        <TrendPanel folder={folder.path} />
      )}
    </section>
  );
};

const FileTable: FC<{
  files: AnalyticsFileDto[];
  onOpen: (fileId: string) => void;
}> = ({ files, onOpen }) => {
  const t = useTranslations('analytics');
  const locale = useLocale();
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('col.name')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('col.period')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('col.delivered')}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t('col.size')}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t('col.availableUntil')}
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {files.map((file) => (
            <tr key={file.id} className="text-black dark:text-white">
              <td className="px-3 py-2">
                {file.canPreview || file.canViewDashboard ? (
                  <button
                    type="button"
                    onClick={() => onOpen(file.id)}
                    aria-label={t('openAria', { name: file.name })}
                    className="break-all text-left font-medium text-blue-700 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300"
                  >
                    {file.name}
                  </button>
                ) : (
                  <span className="break-all">{file.name}</span>
                )}
                {file.admin && <AdminBadges admin={file.admin} />}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-300">
                {formatPeriod(file.period, locale) ?? '—'}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-300">
                {formatDay(file.deliveredAt, locale)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300">
                {formatBytes(file.size)}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-700 dark:text-gray-300">
                {formatDay(file.expiresAt, locale)}
              </td>
              <td className="px-3 py-2 text-right">
                {file.canDownload ? (
                  <a
                    href={analyticsDownloadUrl(file.id)}
                    download={file.name}
                    aria-label={t('downloadAria', { name: file.name })}
                    className={`${ADMIN_BTN_SECONDARY} inline-flex`}
                  >
                    <IconDownload size={16} aria-hidden="true" />
                    {t('download')}
                  </a>
                ) : file.canExport ? (
                  // The delivered file is withheld, but an export without the
                  // hidden fields is one click away inside the preview.
                  <button
                    type="button"
                    className={`${ADMIN_BTN_SECONDARY} inline-flex`}
                    onClick={() => onOpen(file.id)}
                  >
                    {t('openForExport')}
                  </button>
                ) : (
                  <span className={ADMIN_MUTED}>
                    {t(`block.${file.downloadBlock ?? 'not-inspected'}`)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** What only an admin sees on a row: where the file stands for everyone else. */
const AdminBadges: FC<{ admin: NonNullable<AnalyticsFileDto['admin']> }> = ({
  admin,
}) => {
  const t = useTranslations('analytics');
  const chips: { key: string; className: string; label: string }[] = [];
  if (admin.validation === 'error') {
    chips.push({
      key: 'error',
      className: ADMIN_CHIP_DANGER,
      label: t('adminBadge.error'),
    });
  } else if (admin.validation === 'pending') {
    chips.push({
      key: 'pending',
      className: ADMIN_CHIP_NEUTRAL,
      label: t('adminBadge.pending'),
    });
  } else if (admin.validation === 'warning') {
    chips.push({
      key: 'warning',
      className: ADMIN_CHIP_WARN,
      label: t('adminBadge.warning'),
    });
  }
  if (admin.expired) {
    chips.push({
      key: 'expired',
      className: ADMIN_CHIP_WARN,
      label: t('adminBadge.expired'),
    });
  }
  if (admin.originalBlock && admin.validation !== 'error') {
    chips.push({
      key: 'blocked',
      className: ADMIN_CHIP_WARN,
      label: t('adminBadge.originalBlocked', {
        reason: t(`block.${admin.originalBlock}`),
      }),
    });
  }
  if (chips.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      <IconAlertTriangle
        size={14}
        aria-hidden="true"
        className="text-amber-600 dark:text-amber-400"
      />
      {chips.map((chip) => (
        <span key={chip.key} className={chip.className}>
          {chip.label}
        </span>
      ))}
    </span>
  );
};
