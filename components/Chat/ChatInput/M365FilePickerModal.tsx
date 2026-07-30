import {
  IconBrandOnedrive,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconSearch,
} from '@tabler/icons-react';
import { FC, FormEvent, useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import {
  M365ClientError,
  listDrive,
  listSiteDrives,
  searchSites,
} from '@/client/services/m365/m365Client';

import type {
  M365DriveEntry,
  M365DriveInfo,
  M365SiteEntry,
} from '@/types/m365';

import Modal from '@/components/UI/Modal';

interface M365FilePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Override the default attach-to-chat behavior: the picked entry is handed
   * to the caller instead (used by the M365 agent editor to collect
   * sources). When set, folders become pickable too (via a dedicated Add
   * button — clicking a folder still navigates into it).
   */
  onPick?: (entry: M365DriveEntry) => void;
}

type PickerTab = 'onedrive' | 'recent' | 'shared' | 'sharepoint';

/** One drill-down step: a folder (OneDrive), or a site/library (SharePoint). */
interface Crumb {
  label: string;
  siteId?: string;
  driveId?: string;
  itemId?: string;
}

const TABS: PickerTab[] = ['onedrive', 'recent', 'shared', 'sharepoint'];

function formatSize(size: number | undefined): string {
  if (size === undefined) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessageKey(error: unknown): string {
  if (error instanceof M365ClientError) {
    if (error.code === 'M365_CONSENT_MISSING') return 'errors.consentMissing';
    if (error.code === 'M365_NOT_CONNECTED') return 'errors.notConnected';
    if (error.code === 'NETWORK') return 'errors.network';
  }
  return 'errors.generic';
}

/**
 * Browse/search OneDrive ("my files", recent, shared with me) and SharePoint
 * site libraries; picking a file hands it to `useM365Attachment`, which pulls
 * it through the normal upload pipeline. Only while the modal is open does
 * any Graph traffic happen — content stays on the picker's side of the wire
 * until a file is explicitly picked.
 */
const M365FilePickerBody: FC<{
  onClose: () => void;
  onPick?: (entry: M365DriveEntry) => void;
}> = ({ onClose, onPick }) => {
  const t = useTranslations('m365.picker');
  const { attachDriveItem } = useM365Attachment();

  const [tab, setTab] = useState<PickerTab>('onedrive');
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<M365DriveEntry[]>([]);
  const [sites, setSites] = useState<M365SiteEntry[]>([]);
  const [libraries, setLibraries] = useState<M365DriveInfo[]>([]);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<M365DriveEntry[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const lastCrumb = crumbs[crumbs.length - 1];
  const sharePointPhase: 'sites' | 'libraries' | 'browse' =
    tab !== 'sharepoint'
      ? 'browse'
      : crumbs.length === 0
        ? 'sites'
        : crumbs.length === 1
          ? 'libraries'
          : 'browse';

  const load = useCallback(async () => {
    setErrorKey(null);
    setSearchResults(null);
    setLoading(true);
    try {
      if (tab === 'recent' || tab === 'shared') {
        setEntries(await listDrive(tab));
      } else if (tab === 'onedrive') {
        setEntries(
          await listDrive('children', {
            driveId: lastCrumb?.driveId,
            itemId: lastCrumb?.itemId,
          }),
        );
      } else if (sharePointPhase === 'libraries' && crumbs[0]?.siteId) {
        setLibraries(await listSiteDrives(crumbs[0].siteId));
      } else if (sharePointPhase === 'browse' && crumbs[1]?.driveId) {
        setEntries(
          await listDrive('children', {
            driveId: crumbs[1].driveId,
            itemId: lastCrumb?.itemId,
          }),
        );
      }
    } catch (error) {
      setErrorKey(errorMessageKey(error));
    } finally {
      setLoading(false);
    }
  }, [tab, crumbs, lastCrumb, sharePointPhase]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchTab = (next: PickerTab) => {
    setTab(next);
    setCrumbs([]);
    setEntries([]);
    setSites([]);
    setLibraries([]);
    setQuery('');
    setSearchResults(null);
    setErrorKey(null);
  };

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setErrorKey(null);
    setLoading(true);
    try {
      if (tab === 'sharepoint' && sharePointPhase === 'sites') {
        setSites(await searchSites(q));
      } else {
        setSearchResults(
          await listDrive('search', {
            q,
            driveId: tab === 'sharepoint' ? crumbs[1]?.driveId : undefined,
          }),
        );
      }
    } catch (error) {
      setErrorKey(errorMessageKey(error));
    } finally {
      setLoading(false);
    }
  };

  const pickFile = (entry: M365DriveEntry) => {
    if (onPick) {
      onPick(entry);
      onClose();
      return;
    }
    // Continues in the background; progress shows on the attachment tile.
    void attachDriveItem(entry);
    onClose();
  };

  const openFolder = (entry: M365DriveEntry) => {
    setSearchResults(null);
    setQuery('');
    setCrumbs((prev) => [
      ...prev,
      {
        label: entry.name,
        driveId: entry.driveId,
        itemId: entry.itemId,
      },
    ]);
  };

  // Recent/shared are fixed Graph views with no search endpoint of their
  // own; the library-list phase is short enough not to need one either.
  const showSearchBox =
    tab === 'onedrive' ||
    (tab === 'sharepoint' && sharePointPhase !== 'libraries');

  const listedEntries = searchResults ?? entries;

  return (
    <div className="flex h-[420px] flex-col gap-3">
      {/* Tabs */}
      <div
        className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-neutral-700/50"
        role="tablist"
      >
        {TABS.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            onClick={() => switchTab(candidate)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              tab === candidate
                ? 'bg-white text-gray-900 shadow-sm dark:bg-neutral-800 dark:text-gray-100'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {t(`tabs.${candidate}`)}
          </button>
        ))}
      </div>

      {/* Search */}
      {showSearchBox && (
        <form onSubmit={handleSearch} className="flex gap-2">
          <div className="relative flex-1">
            <IconSearch
              size={16}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === 'sharepoint' && sharePointPhase === 'sites'
                  ? t('searchSitesPlaceholder')
                  : t('searchPlaceholder')
              }
              className="w-full rounded-lg border border-gray-300 bg-gray-50 py-1.5 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
            />
          </div>
          <button
            type="submit"
            disabled={!query.trim() || loading}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40"
          >
            {t('search')}
          </button>
        </form>
      )}

      {/* Breadcrumbs */}
      {(crumbs.length > 0 || searchResults) && (
        <nav className="flex flex-wrap items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
          <button
            type="button"
            onClick={() => {
              setCrumbs([]);
              setSearchResults(null);
            }}
            className="hover:text-blue-600 hover:underline dark:hover:text-blue-400"
          >
            {tab === 'sharepoint' ? t('tabs.sharepoint') : t('tabs.onedrive')}
          </button>
          {crumbs.map((crumb, index) => (
            <span
              key={`${crumb.label}-${index}`}
              className="flex items-center gap-1"
            >
              <IconChevronRight size={12} />
              <button
                type="button"
                onClick={() => setCrumbs((prev) => prev.slice(0, index + 1))}
                className="max-w-[140px] truncate hover:text-blue-600 hover:underline dark:hover:text-blue-400"
              >
                {crumb.label}
              </button>
            </span>
          ))}
          {searchResults && (
            <span className="flex items-center gap-1">
              <IconChevronRight size={12} />
              <span>{t('searchResults')}</span>
            </span>
          )}
        </nav>
      )}

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            {t('loading')}
          </div>
        ) : errorKey ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-amber-700 dark:text-amber-400">
            {t(errorKey)}
          </div>
        ) : tab === 'sharepoint' && sharePointPhase === 'sites' ? (
          sites.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('sitesHint')}
            </div>
          ) : (
            <ul>
              {sites.map((site) => (
                <li key={site.siteId}>
                  <button
                    type="button"
                    onClick={() =>
                      setCrumbs([{ label: site.name, siteId: site.siteId }])
                    }
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-neutral-700/50"
                  >
                    <IconBrandOnedrive
                      size={18}
                      className="flex-shrink-0 text-blue-500"
                    />
                    <span className="truncate">{site.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : tab === 'sharepoint' && sharePointPhase === 'libraries' ? (
          <ul>
            {libraries.map((library) => (
              <li key={library.driveId}>
                <button
                  type="button"
                  onClick={() =>
                    setCrumbs((prev) => [
                      ...prev,
                      { label: library.name, driveId: library.driveId },
                    ])
                  }
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-neutral-700/50"
                >
                  <IconFolder
                    size={18}
                    className="flex-shrink-0 text-amber-500"
                  />
                  <span className="truncate">{library.name}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : listedEntries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            {t('empty')}
          </div>
        ) : (
          <ul>
            {listedEntries.map((entry) => (
              <li key={`${entry.driveId}-${entry.itemId}`}>
                <div className="flex items-center">
                  <button
                    type="button"
                    onClick={() =>
                      entry.isFolder ? openFolder(entry) : pickFile(entry)
                    }
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-neutral-700/50"
                  >
                    {entry.isFolder ? (
                      <IconFolder
                        size={18}
                        className="flex-shrink-0 text-amber-500"
                      />
                    ) : (
                      <IconFile
                        size={18}
                        className="flex-shrink-0 text-gray-400"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {entry.name}
                    </span>
                    <span className="flex-shrink-0 text-xs text-gray-400">
                      {entry.isFolder
                        ? (entry.childCount ?? '')
                        : formatSize(entry.size)}
                    </span>
                  </button>
                  {onPick && entry.isFolder && (
                    <button
                      type="button"
                      onClick={() => pickFile(entry)}
                      className="mr-2 flex-shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                    >
                      {t('addFolder')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const M365FilePickerModal: FC<M365FilePickerModalProps> = ({
  isOpen,
  onClose,
  onPick,
}) => {
  const t = useTranslations('m365.picker');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={onPick ? t('pickTitle') : t('title')}
      icon={<IconBrandOnedrive size={20} />}
      size="lg"
    >
      {/* Body mounts fresh per opening, so each session starts at the root. */}
      {isOpen && <M365FilePickerBody onClose={onClose} onPick={onPick} />}
    </Modal>
  );
};

export default M365FilePickerModal;
