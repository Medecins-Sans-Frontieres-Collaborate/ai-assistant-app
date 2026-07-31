import {
  IconArrowNarrowDown,
  IconArrowNarrowUp,
  IconBrandOnedrive,
  IconChevronRight,
  IconFolder,
  IconLoader2,
  IconSearch,
} from '@tabler/icons-react';
import {
  FC,
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import {
  DriveView,
  M365ClientError,
  M365_SEARCH_DEBOUNCE_MS,
  M365_SEARCH_MIN_CHARS,
  listDrivePage,
  listSiteDrives,
  searchSites,
} from '@/client/services/m365/m365Client';

import type {
  M365DriveEntry,
  M365DriveInfo,
  M365DriveSort,
  M365SaveDestination,
  M365SiteEntry,
  M365SortDir,
} from '@/types/m365';

import M365FileTypeIcon from '@/components/Chat/ChatInput/M365FileTypeIcon';
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
  /**
   * Folders-only pick mode for choosing a save destination (wins over
   * `onPick` when both are set): tabs shrink to OneDrive + SharePoint, file
   * rows render disabled, folder rows navigate on click and gain a Select
   * button in browse listings, and a footer bar picks the folder currently
   * being browsed (the only way to select from search results — their rows
   * navigate only).
   */
  onPickFolder?: (destination: M365SaveDestination) => void;
}

type PickerTab = 'onedrive' | 'recent' | 'shared' | 'sharepoint';

/** One drill-down step: a folder (OneDrive), or a site/library (SharePoint). */
interface Crumb {
  label: string;
  siteId?: string;
  driveId?: string;
  itemId?: string;
}

interface EntryPage {
  entries: M365DriveEntry[];
  nextToken: string | null;
}

const TABS: PickerTab[] = ['onedrive', 'recent', 'shared', 'sharepoint'];

// Folder mode drops recent (files-only in Graph, unreliable $orderby) and
// shared (writes there depend on the sharer's permissions — deferred).
const FOLDER_TABS: PickerTab[] = ['onedrive', 'sharepoint'];

const SEARCH_DEBOUNCE_MS = M365_SEARCH_DEBOUNCE_MS;
const SEARCH_MIN_CHARS = M365_SEARCH_MIN_CHARS;

const SORT_FIELDS: M365DriveSort[] = ['name', 'lastModified', 'size'];

const SORT_LABEL_KEYS: Record<M365DriveSort, string> = {
  name: 'sort.name',
  lastModified: 'sort.modified',
  size: 'sort.size',
};

const DEFAULT_SORT_DIRS: Record<M365DriveSort, M365SortDir> = {
  name: 'asc',
  lastModified: 'desc',
  size: 'desc',
};

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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Graph paging can duplicate items when the drive mutates between pages;
 * duplicate keys would crash the list, so appends dedupe by driveId/itemId.
 */
function appendDeduped(
  prev: M365DriveEntry[],
  incoming: M365DriveEntry[],
): M365DriveEntry[] {
  const seen = new Set(prev.map((entry) => `${entry.driveId}/${entry.itemId}`));
  const fresh = incoming.filter((entry) => {
    const key = `${entry.driveId}/${entry.itemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
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
  onPickFolder?: (destination: M365SaveDestination) => void;
}> = ({ onClose, onPick: onPickProp, onPickFolder }) => {
  const t = useTranslations('m365.picker');
  const folderMode = Boolean(onPickFolder);
  // onPickFolder wins over onPick — the modes are mutually exclusive.
  const onPick = folderMode ? undefined : onPickProp;
  const locale = useLocale();
  const { attachDriveItem } = useM365Attachment();

  const [tab, setTab] = useState<PickerTab>('onedrive');
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [entries, setEntries] = useState<M365DriveEntry[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [sites, setSites] = useState<M365SiteEntry[]>([]);
  const [libraries, setLibraries] = useState<M365DriveInfo[]>([]);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EntryPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [searchErrorKey, setSearchErrorKey] = useState<string | null>(null);
  const [sort, setSort] = useState<M365DriveSort>('name');
  const [dir, setDir] = useState<M365SortDir>('asc');

  // Only the latest search may write state; aborts cancel superseded fetches.
  const searchSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  // Guards the browse/search listing against out-of-order responses: bumped
  // whenever the listing identity changes (navigation, tab switch, reload,
  // new search), and checked after every await before state is written.
  const listSeqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  const lastCrumb = crumbs[crumbs.length - 1];
  const sharePointPhase: 'sites' | 'libraries' | 'browse' =
    tab !== 'sharepoint'
      ? 'browse'
      : crumbs.length === 0
        ? 'sites'
        : crumbs.length === 1
          ? 'libraries'
          : 'browse';

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    [locale],
  );

  const cancelSearch = useCallback(() => {
    searchSeqRef.current += 1;
    // Every caller is also changing the listing, so in-flight page appends
    // for the old listing must be invalidated along with the search.
    listSeqRef.current += 1;
    searchAbortRef.current?.abort();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(false);
    setSearchErrorKey(null);
  }, []);

  const load = useCallback(async () => {
    const seq = ++listSeqRef.current;
    setErrorKey(null);
    setSearchResults(null);
    setLoadMoreFailed(false);
    setNextToken(null);
    setLoading(true);
    try {
      if (tab === 'recent' || tab === 'shared') {
        const page = await listDrivePage(tab);
        if (seq !== listSeqRef.current) return;
        setEntries(page.entries);
        setNextToken(page.nextToken ?? null);
      } else if (tab === 'onedrive') {
        const page = await listDrivePage('children', {
          driveId: lastCrumb?.driveId,
          itemId: lastCrumb?.itemId,
          sort,
          dir,
        });
        if (seq !== listSeqRef.current) return;
        setEntries(page.entries);
        setNextToken(page.nextToken ?? null);
      } else if (sharePointPhase === 'libraries' && crumbs[0]?.siteId) {
        const drives = await listSiteDrives(crumbs[0].siteId);
        if (seq !== listSeqRef.current) return;
        setLibraries(drives);
      } else if (sharePointPhase === 'browse' && crumbs[1]?.driveId) {
        const page = await listDrivePage('children', {
          driveId: crumbs[1].driveId,
          itemId: lastCrumb?.itemId,
          sort,
          dir,
        });
        if (seq !== listSeqRef.current) return;
        setEntries(page.entries);
        setNextToken(page.nextToken ?? null);
      }
    } catch (error) {
      if (seq !== listSeqRef.current) return;
      setErrorKey(errorMessageKey(error));
    } finally {
      if (seq === listSeqRef.current) setLoading(false);
    }
  }, [tab, crumbs, lastCrumb, sharePointPhase, sort, dir]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    const inSearch = searchResults !== null;
    const token = inSearch ? searchResults.nextToken : nextToken;
    if (!token || loading || loadingMore) return;
    // A response that arrives after the listing changed under it (navigation,
    // tab switch, new search) must be dropped, not appended.
    const seq = listSeqRef.current;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    const view: DriveView = inSearch
      ? 'search'
      : tab === 'recent' || tab === 'shared'
        ? tab
        : 'children';
    try {
      const page = await listDrivePage(view, {
        pageToken: token,
        q: inSearch ? query.trim() || undefined : undefined,
      });
      if (seq !== listSeqRef.current) return;
      if (inSearch) {
        setSearchResults(
          (prev) =>
            prev && {
              entries: appendDeduped(prev.entries, page.entries),
              nextToken: page.nextToken ?? null,
            },
        );
      } else {
        setEntries((prev) => appendDeduped(prev, page.entries));
        setNextToken(page.nextToken ?? null);
      }
    } catch (error) {
      if (isAbortError(error)) return;
      if (seq !== listSeqRef.current) return;
      // Never discard already-loaded rows on a pagination failure.
      setLoadMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  }, [searchResults, nextToken, loading, loadingMore, tab, query]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  const searchActive = searchResults !== null;
  const activeNextToken = searchActive ? searchResults.nextToken : nextToken;

  // Infinite scroll: observe the sentinel row inside the list's own scroll
  // container. The sentinel stays a real, clickable Load-more button so
  // pagination survives environments where the observer never fires.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!activeNextToken || loadMoreFailed || !sentinel || !root) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((o) => o.isIntersecting)) {
          void loadMoreRef.current();
        }
      },
      { root, rootMargin: '120px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [activeNextToken, loadMoreFailed, tab, sharePointPhase, searchActive]);

  const runSearch = useCallback(
    async (q: string) => {
      const seq = ++searchSeqRef.current;
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearching(true);
      setSearchErrorKey(null);
      try {
        if (tab === 'sharepoint' && sharePointPhase === 'sites') {
          const found = await searchSites(q);
          if (seq !== searchSeqRef.current) return;
          setSites(found);
        } else {
          const page = await listDrivePage('search', {
            q,
            driveId: tab === 'sharepoint' ? crumbs[1]?.driveId : undefined,
            signal: controller.signal,
          });
          if (seq !== searchSeqRef.current) return;
          // The search listing replaces the browse listing; drop any browse
          // page append still in flight.
          listSeqRef.current += 1;
          setSearchResults({
            entries: page.entries,
            nextToken: page.nextToken ?? null,
          });
          setLoadMoreFailed(false);
        }
      } catch (error) {
        if (isAbortError(error)) return;
        if (seq !== searchSeqRef.current) return;
        // Search failures are inline and never blank the loaded list.
        setSearchErrorKey(errorMessageKey(error));
      } finally {
        if (seq === searchSeqRef.current) setSearching(false);
      }
    },
    [tab, sharePointPhase, crumbs],
  );

  // Recent/shared are fixed Graph views with no search endpoint of their
  // own; the library-list phase is short enough not to need one either.
  const showSearchBox =
    tab === 'onedrive' ||
    (tab === 'sharepoint' && sharePointPhase !== 'libraries');

  // Debounced search-as-you-type; below the minimum length any in-flight
  // search is cancelled and the browse listing returns.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!showSearchBox || q.length < SEARCH_MIN_CHARS) {
      searchSeqRef.current += 1;
      searchAbortRef.current?.abort();
      setSearching(false);
      setSearchErrorKey(null);
      setSearchResults(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(q);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, showSearchBox, runSearch]);

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const switchTab = (next: PickerTab) => {
    cancelSearch();
    setTab(next);
    setCrumbs([]);
    setEntries([]);
    setNextToken(null);
    setSites([]);
    setLibraries([]);
    setQuery('');
    setSearchResults(null);
    setErrorKey(null);
    setLoadMoreFailed(false);
    setSort('name');
    setDir('asc');
  };

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    // The route rejects shorter queries too — same guard on the Enter path.
    if (q.length < SEARCH_MIN_CHARS) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    void runSearch(q);
  };

  const handleSort = (field: M365DriveSort) => {
    if (sort === field) {
      setDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(field);
      setDir(DEFAULT_SORT_DIRS[field]);
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
    cancelSearch();
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

  const rootLabel =
    tab === 'sharepoint' ? t('tabs.sharepoint') : t('tabs.onedrive');

  const pickFolderEntry = (entry: M365DriveEntry) => {
    onPickFolder?.({
      driveId: entry.driveId,
      itemId: entry.itemId,
      name: entry.name,
      pathLabel: [rootLabel, ...crumbs.map((c) => c.label), entry.name].join(
        ' › ',
      ),
    });
    onClose();
  };

  // The folder currently being browsed, when it is an addressable save
  // target: OneDrive needs a real folder crumb (the root's driveId is never
  // known client-side — the app-folder default already covers "just my
  // OneDrive"), SharePoint needs at least the library crumb (a null itemId
  // targets the library root via /drives/{d}/root:).
  let currentDestination: M365SaveDestination | null = null;
  if (folderMode) {
    const crumbPath = [rootLabel, ...crumbs.map((c) => c.label)].join(' › ');
    if (tab === 'onedrive' && lastCrumb?.driveId && lastCrumb.itemId) {
      currentDestination = {
        driveId: lastCrumb.driveId,
        itemId: lastCrumb.itemId,
        name: lastCrumb.label,
        pathLabel: crumbPath,
      };
    } else if (
      tab === 'sharepoint' &&
      sharePointPhase === 'browse' &&
      crumbs[1]?.driveId
    ) {
      currentDestination = {
        driveId: crumbs[1].driveId,
        itemId: lastCrumb?.itemId ?? null,
        name: lastCrumb?.label ?? '',
        pathLabel: crumbPath,
      };
    }
  }

  const showSortPills =
    !searchActive &&
    (tab === 'onedrive' ||
      (tab === 'sharepoint' && sharePointPhase === 'browse'));

  const listedEntries = searchActive ? searchResults.entries : entries;
  const trimmedQuery = query.trim();

  return (
    <div className="flex h-[420px] flex-col gap-3">
      {/* Tabs */}
      <div
        className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-neutral-700/50"
        role="tablist"
      >
        {(folderMode ? FOLDER_TABS : TABS).map((candidate) => (
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
        <form onSubmit={handleSearch} className="flex flex-col gap-1">
          <div className="relative">
            <IconSearch
              size={16}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              // Also carries focus across the save-dialog → picker swap,
              // which would otherwise drop keyboard focus to the body.
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  // Consume Escape only to clear a non-empty query; an empty
                  // input leaves Escape-to-close to the Modal.
                  event.stopPropagation();
                  setQuery('');
                }
              }}
              placeholder={
                tab === 'sharepoint' && sharePointPhase === 'sites'
                  ? t('searchSitesPlaceholder')
                  : t('searchPlaceholder')
              }
              className="w-full rounded-lg border border-gray-300 bg-gray-50 py-1.5 pl-8 pr-8 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
            />
            {searching && (
              <IconLoader2
                size={16}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-gray-400"
              />
            )}
          </div>
          {trimmedQuery.length === 1 && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {t('searchMinChars')}
            </p>
          )}
          {searchErrorKey && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {t(searchErrorKey)}
            </p>
          )}
        </form>
      )}

      {/* Breadcrumbs */}
      {(crumbs.length > 0 || searchActive) && (
        <nav className="flex flex-wrap items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
          <button
            type="button"
            onClick={() => {
              cancelSearch();
              setCrumbs([]);
              setQuery('');
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
          {searchActive && (
            <span className="flex items-center gap-1">
              <IconChevronRight size={12} />
              <span>{t('searchResults')}</span>
            </span>
          )}
        </nav>
      )}

      {/* Sort pills — children listings only (Graph rejects $orderby on
          recent/shared/search). */}
      {showSortPills && (
        <div
          className="flex items-center justify-end"
          role="group"
          aria-label={t('sort.label')}
        >
          <div className="flex gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-neutral-700/50">
            {SORT_FIELDS.map((field) => {
              const active = sort === field;
              return (
                <button
                  key={field}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleSort(field)}
                  className={`flex items-center gap-0.5 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-white text-gray-900 shadow-sm dark:bg-neutral-800 dark:text-gray-100'
                      : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200'
                  }`}
                >
                  {t(SORT_LABEL_KEYS[field])}
                  {active &&
                    (dir === 'asc' ? (
                      <IconArrowNarrowUp size={14} />
                    ) : (
                      <IconArrowNarrowDown size={14} />
                    ))}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Content */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700"
      >
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
                    onClick={() => {
                      cancelSearch();
                      setQuery('');
                      setCrumbs([{ label: site.name, siteId: site.siteId }]);
                    }}
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
                  onClick={() => {
                    cancelSearch();
                    setQuery('');
                    setCrumbs((prev) => [
                      ...prev,
                      { label: library.name, driveId: library.driveId },
                    ]);
                  }}
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
          searchActive ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-gray-500 dark:text-gray-400">
              <IconSearch size={24} className="text-gray-400" />
              {t('noResults', { query: trimmedQuery })}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
              {tab === 'recent' || tab === 'shared'
                ? t('empty')
                : t('emptyFolder')}
            </div>
          )
        ) : (
          <ul>
            {listedEntries.map((entry) => (
              <li key={`${entry.driveId}-${entry.itemId}`}>
                <div className="flex items-center">
                  {/* Folder mode keeps file rows visible for orientation but
                      inert — only folders can be navigated or selected. */}
                  <button
                    type="button"
                    disabled={folderMode && !entry.isFolder}
                    onClick={() =>
                      entry.isFolder
                        ? openFolder(entry)
                        : folderMode
                          ? undefined
                          : pickFile(entry)
                    }
                    className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 dark:text-gray-200 ${
                      folderMode && !entry.isFolder
                        ? 'cursor-default opacity-50'
                        : 'hover:bg-gray-100 dark:hover:bg-neutral-700/50'
                    }`}
                  >
                    <M365FileTypeIcon entry={entry} size={18} />
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={entry.name}
                    >
                      {entry.name}
                    </span>
                    <span className="hidden w-24 flex-shrink-0 text-right text-xs text-gray-400 sm:inline">
                      {entry.lastModified
                        ? dateFormatter.format(new Date(entry.lastModified))
                        : ''}
                    </span>
                    <span className="w-16 flex-shrink-0 text-right text-xs text-gray-400">
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
                  {/* Browse rows only: a search hit's breadcrumb is unknown,
                      so selecting from search means navigating in first and
                      using the footer bar (honest pathLabel). */}
                  {folderMode && entry.isFolder && !searchActive && (
                    <button
                      type="button"
                      onClick={() => pickFolderEntry(entry)}
                      className="mr-2 flex-shrink-0 rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                    >
                      {t('selectFolder')}
                    </button>
                  )}
                </div>
              </li>
            ))}
            {loadMoreFailed ? (
              <li className="flex items-center justify-center gap-2 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                <span>{t('loadMoreFailed')}</span>
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  className="rounded-md border border-neutral-300 px-2 py-0.5 text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                >
                  {t('retry')}
                </button>
              </li>
            ) : activeNextToken ? (
              <li ref={sentinelRef} className="p-2">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs text-gray-600 hover:bg-gray-100 disabled:pointer-events-none dark:text-gray-400 dark:hover:bg-neutral-700/50"
                >
                  {loadingMore ? (
                    <>
                      <IconLoader2 size={14} className="animate-spin" />
                      {t('loadingMore')}
                    </>
                  ) : (
                    t('loadMore')
                  )}
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {/* Folder-mode footer: outside the scroll container so it never
          competes with the load-more sentinel. Selects the folder being
          browsed; disabled wherever no addressable target exists (OneDrive
          root, SharePoint site/library phases). */}
      {folderMode && (
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-gray-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
          <IconFolder size={18} className="flex-shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-400">
            {[rootLabel, ...crumbs.map((c) => c.label)].join(' › ')}
          </span>
          <button
            type="button"
            disabled={!currentDestination}
            onClick={() => {
              if (!currentDestination) return;
              onPickFolder?.(currentDestination);
              onClose();
            }}
            className="flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('selectCurrentFolder')}
          </button>
        </div>
      )}
    </div>
  );
};

const M365FilePickerModal: FC<M365FilePickerModalProps> = ({
  isOpen,
  onClose,
  onPick,
  onPickFolder,
}) => {
  const t = useTranslations('m365.picker');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        onPickFolder ? t('folderTitle') : onPick ? t('pickTitle') : t('title')
      }
      icon={<IconBrandOnedrive size={20} />}
      size="lg"
    >
      {/* Body mounts fresh per opening, so each session starts at the root. */}
      {isOpen && (
        <M365FilePickerBody
          onClose={onClose}
          onPick={onPick}
          onPickFolder={onPickFolder}
        />
      )}
    </Modal>
  );
};

export default M365FilePickerModal;
