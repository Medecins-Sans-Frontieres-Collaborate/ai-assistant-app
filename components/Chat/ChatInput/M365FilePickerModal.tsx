import {
  IconArrowNarrowDown,
  IconArrowNarrowUp,
  IconBrandOnedrive,
  IconChevronRight,
  IconDots,
  IconFileTypeDoc,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeTxt,
  IconFileTypeXls,
  IconFilterOff,
  IconFolder,
  IconHome,
  IconLoader2,
  IconMusic,
  IconPhoto,
  IconSearch,
  IconUsersGroup,
  IconVideo,
} from '@tabler/icons-react';
import {
  FC,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';
import useEnhancedOutsideClick from '@/client/hooks/ui/useEnhancedOutsideClick';

import {
  queryDriveNameCache,
  recordDriveEntries,
} from '@/client/services/m365/driveNameCache';
import {
  DriveView,
  M365_SEARCH_DEBOUNCE_MS,
  M365_SEARCH_MIN_CHARS,
  getTeamDrive,
  listDrivePage,
  listJoinedTeams,
  listSiteDrives,
  listSites,
  searchSites,
} from '@/client/services/m365/m365Client';
import {
  M365ErrorKind,
  m365ErrorKind,
} from '@/client/services/m365/m365ErrorKinds';

import {
  M365FileTypeGroupId,
  M365_FILE_TYPE_GROUPS,
  M365_PRIMARY_FILE_TYPE_IDS,
  fileExtension,
  getFileTypeGroup,
} from '@/lib/utils/app/m365FileTypes';

import type {
  M365DriveEntry,
  M365DriveInfo,
  M365DriveSort,
  M365PickerCrumb,
  M365PickerLocation,
  M365PickerTab,
  M365SaveDestination,
  M365SiteEntry,
  M365SortDir,
  M365TeamEntry,
} from '@/types/m365';

import M365FileTypeIcon from '@/components/Chat/ChatInput/M365FileTypeIcon';
import Modal from '@/components/UI/Modal';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';

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
  /**
   * Per-consumer file-type filter (third-pass shared foundation): lowercase
   * extensions without the dot. Non-matching files stay visible for
   * orientation but render disabled; folders always navigate. Ignored in
   * folder mode.
   */
  acceptExtensions?: string[];
}

type PickerTab = M365PickerTab;

/** One drill-down step: a folder (OneDrive), or a site/library (SharePoint). */
type Crumb = M365PickerCrumb;

interface EntryPage {
  entries: M365DriveEntry[];
  nextToken: string | null;
}

/** SharePoint browse listing: followed sites + paged all-sites list. */
interface SiteBrowseState {
  followed: M365SiteEntry[];
  sites: M365SiteEntry[];
  nextToken: string | null;
}

const TABS: PickerTab[] = [
  'onedrive',
  'recent',
  'shared',
  'sharepoint',
  'teams',
];

// Folder mode drops recent (files-only in Graph, unreliable $orderby) and
// shared (writes there depend on the sharer's permissions — deferred).
const FOLDER_TABS: PickerTab[] = ['onedrive', 'sharepoint', 'teams'];

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

// Type-filter chips are icon-only (tooltip + aria-label carry the name);
// icon shapes and accent colors match M365FileTypeIcon's row icons so the
// chip reads as "files that look like this".
const TYPE_FILTER_ICONS: Record<
  M365FileTypeGroupId,
  [typeof IconSearch, string]
> = {
  word: [IconFileTypeDoc, 'text-blue-600 dark:text-blue-400'],
  excel: [IconFileTypeXls, 'text-green-600 dark:text-green-400'],
  pdf: [IconFileTypePdf, 'text-red-500'],
  powerpoint: [IconFileTypePpt, 'text-orange-500'],
  text: [IconFileTypeTxt, 'text-gray-500'],
  image: [IconPhoto, 'text-purple-500'],
  audio: [IconMusic, 'text-purple-500'],
  video: [IconVideo, 'text-purple-500'],
};

// Groups behind the "…" menu (everything not shown as an inline chip).
const MORE_FILE_TYPE_IDS: readonly M365FileTypeGroupId[] =
  M365_FILE_TYPE_GROUPS.map((group) => group.id).filter(
    (id) => !M365_PRIMARY_FILE_TYPE_IDS.includes(id),
  );

const ERROR_KIND_KEYS: Partial<Record<M365ErrorKind, string>> = {
  consentMissing: 'errors.consentMissing',
  notConnected: 'errors.notConnected',
  network: 'errors.network',
  notFound: 'errors.notFound',
  forbidden: 'errors.forbidden',
  rateLimited: 'errors.rateLimited',
};

function errorMessageKey(error: unknown): string {
  return ERROR_KIND_KEYS[m365ErrorKind(error)] ?? 'errors.generic';
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
 * Site-list appends dedupe by siteId — continuation pages can repeat sites
 * (and are not guaranteed to be trimmed against the followed list).
 */
function appendDedupedSites(
  prev: M365SiteEntry[],
  incoming: M365SiteEntry[],
  alsoSeen: M365SiteEntry[],
): M365SiteEntry[] {
  const seen = new Set([...alsoSeen, ...prev].map((site) => site.siteId));
  const fresh = incoming.filter((site) => {
    if (seen.has(site.siteId)) return false;
    seen.add(site.siteId);
    return true;
  });
  return fresh.length > 0 ? [...prev, ...fresh] : prev;
}

/** Breadcrumb labels for path strings, with "…" standing in for elided gaps. */
function crumbLabels(crumbs: Crumb[]): string[] {
  return crumbs.flatMap((crumb) =>
    crumb.elided ? ['…', crumb.label] : [crumb.label],
  );
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
  acceptExtensions?: string[];
}> = ({ onClose, onPick: onPickProp, onPickFolder, acceptExtensions }) => {
  const t = useTranslations('m365.picker');
  const folderMode = Boolean(onPickFolder);
  // onPickFolder wins over onPick — the modes are mutually exclusive.
  const onPick = folderMode ? undefined : onPickProp;
  // Plain attach-to-chat mode: the only mode with location memory and
  // multi-select. Source-collection (onPick) pickers start fresh at the
  // root; folder (save-destination) mode reopens at the remembered save
  // destination below.
  const attachMode = !folderMode && !onPick;
  const locale = useLocale();
  const { attachDriveItem } = useM365Attachment();

  // Read once per opening (the body mounts fresh each time); navigation
  // writes it back below (attach mode only). Sanitized so a shape from
  // another build falls back to the root instead of wedging the picker.
  const [initialLocation] = useState<M365PickerLocation | null>(() => {
    if (attachMode) {
      const stored = useSettingsStore.getState().m365PickerLocation;
      if (
        !stored ||
        !TABS.includes(stored.tab) ||
        !Array.isArray(stored.crumbs)
      )
        return null;
      return stored;
    }
    if (folderMode) {
      // Folder mode opens at the remembered save destination when it
      // recorded its picker trail; restore failures fall back to the tab
      // root via restorePendingRef, same as attach mode.
      const destination = useSettingsStore.getState().m365SaveDestination;
      if (
        destination?.tab &&
        FOLDER_TABS.includes(destination.tab) &&
        Array.isArray(destination.crumbs) &&
        destination.crumbs.length > 0
      ) {
        return {
          tab: destination.tab,
          crumbs: destination.crumbs,
          sort: 'name',
          dir: 'asc',
        };
      }
    }
    return null;
  });

  const [tab, setTab] = useState<PickerTab>(initialLocation?.tab ?? 'onedrive');
  const [crumbs, setCrumbs] = useState<Crumb[]>(initialLocation?.crumbs ?? []);
  const [entries, setEntries] = useState<M365DriveEntry[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  // SharePoint site SEARCH results (?q=); the browse listing is siteBrowse.
  const [sites, setSites] = useState<M365SiteEntry[]>([]);
  // SharePoint browse listing (followed + all sites). Session-cached: kept
  // across searches and navigation so returning to the sites phase never
  // refetches; the ref mirror lets load() consult the cache without
  // depending on the state (which would churn its identity).
  const [siteBrowse, setSiteBrowse] = useState<SiteBrowseState | null>(null);
  const siteBrowseRef = useRef<SiteBrowseState | null>(null);
  useEffect(() => {
    siteBrowseRef.current = siteBrowse;
  }, [siteBrowse]);
  const [sitesLoadingMore, setSitesLoadingMore] = useState(false);
  const [sitesLoadMoreFailed, setSitesLoadMoreFailed] = useState(false);
  const [teams, setTeams] = useState<M365TeamEntry[]>([]);
  const [libraries, setLibraries] = useState<M365DriveInfo[]>([]);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EntryPage | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [searchErrorKey, setSearchErrorKey] = useState<string | null>(null);
  const [sort, setSort] = useState<M365DriveSort>(
    initialLocation && SORT_FIELDS.includes(initialLocation.sort)
      ? initialLocation.sort
      : 'name',
  );
  const [dir, setDir] = useState<M365SortDir>(
    initialLocation?.dir === 'desc' ? 'desc' : 'asc',
  );
  // Attach-mode selection for batch attach; keyed by driveId/itemId and kept
  // across navigation and tab switches so a batch can span folders.
  const [selected, setSelected] = useState<Map<string, M365DriveEntry>>(
    () => new Map(),
  );
  // User-facing type filter (Word/Excel/PDF/…): kept across folder
  // navigation ("find the PDF somewhere in here"), reset on tab switch like
  // sort. null = all types.
  const [typeFilter, setTypeFilter] = useState<M365FileTypeGroupId | null>(
    null,
  );
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement | null>(null);
  const typeMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  useEnhancedOutsideClick(
    typeMenuRef,
    () => setTypeMenuOpen(false),
    typeMenuOpen,
  );

  // Escape closes the open type-filter menu BEFORE the modal: useModal
  // listens for Escape on the document in the bubble phase, so a capture
  // listener wins the race and stops propagation while the menu is open.
  useEffect(() => {
    if (!typeMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setTypeMenuOpen(false);
      typeMenuButtonRef.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [typeMenuOpen]);

  // True when the server dropped the requested children $orderby (tenant
  // field restrictions): the sort pills must not claim an order the rows
  // don't have.
  const [sortUnavailable, setSortUnavailable] = useState(false);
  // Distinguishes "no site search yet" (hint) from "search ran and found
  // nothing" (no-results message) on the SharePoint sites phase.
  const [sitesSearched, setSitesSearched] = useState(false);

  // True until the restored location loads once; a failure then falls back
  // to the tab root instead of surfacing an error for a navigation the
  // user didn't just make.
  const restorePendingRef = useRef(
    initialLocation !== null && initialLocation.crumbs.length > 0,
  );

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

  // Byte sizes with a locale-aware decimal separator ("1,5 MB" in de/fr);
  // the latin unit suffixes are intentionally kept as-is.
  const sizeFormatters = useMemo(
    () => ({
      integer: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      oneDecimal: new Intl.NumberFormat(locale, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    }),
    [locale],
  );
  const formatSize = useCallback(
    (size: number | undefined): string => {
      if (size === undefined) return '';
      if (size < 1024) return `${sizeFormatters.integer.format(size)} B`;
      if (size < 1024 * 1024)
        return `${sizeFormatters.integer.format(size / 1024)} KB`;
      return `${sizeFormatters.oneDecimal.format(size / (1024 * 1024))} MB`;
    },
    [sizeFormatters],
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
    setSitesSearched(false);
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
        recordDriveEntries(page.entries);
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
        recordDriveEntries(page.entries);
        setEntries(page.entries);
        setNextToken(page.nextToken ?? null);
        setSortUnavailable(page.sortApplied === false);
      } else if (tab === 'teams' && crumbs.length === 0) {
        const found = await listJoinedTeams();
        if (seq !== listSeqRef.current) return;
        setTeams(found);
      } else if (tab === 'teams' && crumbs[0]?.driveId) {
        const page = await listDrivePage('children', {
          driveId: crumbs[0].driveId,
          itemId: lastCrumb?.itemId,
          sort,
          dir,
        });
        if (seq !== listSeqRef.current) return;
        recordDriveEntries(page.entries);
        setEntries(page.entries);
        setNextToken(page.nextToken ?? null);
        setSortUnavailable(page.sortApplied === false);
      } else if (sharePointPhase === 'sites') {
        // Browse listing (followed + all sites), fetched once per session:
        // returning from a site or clearing a search reuses the cache.
        if (!siteBrowseRef.current) {
          const sitesPage = await listSites();
          if (seq !== listSeqRef.current) return;
          const followed = sitesPage.followed ?? [];
          setSiteBrowse({
            followed,
            // The server dedupes the first page against followed; repeat it
            // client-side anyway — duplicate keys would crash the list.
            sites: appendDedupedSites([], sitesPage.sites, followed),
            nextToken: sitesPage.nextToken ?? null,
          });
        }
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
        recordDriveEntries(page.entries);
        setEntries(page.entries);
        setNextToken(page.nextToken ?? null);
        setSortUnavailable(page.sortApplied === false);
      }
      if (seq === listSeqRef.current) restorePendingRef.current = false;
    } catch (error) {
      if (seq !== listSeqRef.current) return;
      if (restorePendingRef.current) {
        // Fail-open restore: the remembered folder is gone or no longer
        // accessible. Reset to the tab root (which reloads) instead of
        // showing an error for a folder the user didn't just click; the
        // persist effect below then drops the stale location.
        restorePendingRef.current = false;
        setCrumbs([]);
        return;
      }
      setErrorKey(errorMessageKey(error));
    } finally {
      if (seq === listSeqRef.current) setLoading(false);
    }
  }, [tab, crumbs, lastCrumb, sharePointPhase, sort, dir]);

  useEffect(() => {
    void load();
  }, [load]);

  // Location memory (attach mode only): persisted on every navigation
  // change. Searching never touches tab/crumbs/sort, so the remembered
  // location stays at the pre-search browse spot by construction.
  useEffect(() => {
    if (!attachMode) return;
    useSettingsStore
      .getState()
      .setM365PickerLocation({ tab, crumbs, sort, dir });
  }, [attachMode, tab, crumbs, sort, dir]);

  // Warm the session name index with recent files so search-as-you-type has
  // instant local matches from the first keystroke of the first search.
  useEffect(() => {
    void listDrivePage('recent')
      .then((page) => recordDriveEntries(page.entries))
      .catch(() => undefined);
  }, []);

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

  // All-sites pagination, mirroring loadMore's guarantees: seq-guarded
  // appends, dedupe, and loaded rows survive a pagination failure.
  const loadMoreSites = useCallback(async () => {
    const browse = siteBrowseRef.current;
    if (!browse?.nextToken || sitesLoadingMore) return;
    const seq = listSeqRef.current;
    setSitesLoadingMore(true);
    setSitesLoadMoreFailed(false);
    try {
      const sitesPage = await listSites(browse.nextToken);
      if (seq !== listSeqRef.current) return;
      setSiteBrowse(
        (prev) =>
          prev && {
            followed: prev.followed,
            sites: appendDedupedSites(
              prev.sites,
              sitesPage.sites,
              prev.followed,
            ),
            nextToken: sitesPage.nextToken ?? null,
          },
      );
    } catch (error) {
      if (isAbortError(error)) return;
      if (seq !== listSeqRef.current) return;
      // Never discard already-loaded rows on a pagination failure.
      setSitesLoadMoreFailed(true);
    } finally {
      setSitesLoadingMore(false);
    }
  }, [sitesLoadingMore]);

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
          const found = await searchSites(q, controller.signal);
          if (seq !== searchSeqRef.current) return;
          setSites(found);
          setSitesSearched(true);
        } else {
          // The type filter rides along so the server-side filename query
          // returns name matches OF THAT TYPE (client filtering alone would
          // hide all 25 guaranteed hits when none carry the extension).
          const typeExtensions = typeFilter
            ? getFileTypeGroup(typeFilter)?.extensions
            : undefined;
          const page = await listDrivePage('search', {
            q,
            driveId:
              tab === 'sharepoint'
                ? crumbs[1]?.driveId
                : tab === 'teams'
                  ? crumbs[0]?.driveId
                  : undefined,
            ...(typeExtensions && { types: typeExtensions }),
            signal: controller.signal,
          });
          if (seq !== searchSeqRef.current) return;
          // The search listing replaces the browse listing; drop any browse
          // page append still in flight.
          listSeqRef.current += 1;
          recordDriveEntries(page.entries);
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
    [tab, sharePointPhase, crumbs, typeFilter],
  );

  // Recent/shared are fixed Graph views with no search endpoint of their
  // own; the library-list phase is short enough not to need one either.
  const showSearchBox =
    tab === 'onedrive' ||
    (tab === 'sharepoint' && sharePointPhase !== 'libraries') ||
    (tab === 'teams' && crumbs.length > 0);

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
      // Site results are search-only state: dropping the query below the
      // minimum must clear them too, or stale sites linger under an
      // unrelated (shorter) query.
      setSites([]);
      setSitesSearched(false);
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
    // The siteBrowse cache itself survives tab switches; only its transient
    // pagination-failure state resets.
    setSitesLoadMoreFailed(false);
    setSort('name');
    setDir('asc');
    setSortUnavailable(false);
    setTypeFilter(null);
    setTypeMenuOpen(false);
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

  const entryKey = (entry: M365DriveEntry) =>
    `${entry.driveId}/${entry.itemId}`;

  const toggleSelected = (entry: M365DriveEntry) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = entryKey(entry);
      if (next.has(key)) next.delete(key);
      else next.set(key, entry);
      return next;
    });
  };

  const attachSelected = () => {
    // Each attach continues in the background on its own attachment tile.
    selected.forEach((entry) => void attachDriveItem(entry));
    onClose();
  };

  /**
   * Roving arrow-key focus over the list's enabled row buttons. Returns
   * whether focus moved, so callers only preventDefault when it did.
   */
  const focusListButton = (offset: 1 | -1): boolean => {
    const root = listRef.current;
    if (!root) return false;
    const buttons = Array.from(
      root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    if (buttons.length === 0) return false;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      index === -1
        ? buttons[0]
        : buttons[Math.min(Math.max(index + offset, 0), buttons.length - 1)];
    next.focus();
    return true;
  };

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (focusListButton(event.key === 'ArrowDown' ? 1 : -1)) {
      event.preventDefault();
    }
  };

  const visibleTabs = folderMode ? FOLDER_TABS : TABS;

  // ARIA tabs pattern: roving tabindex with arrow-key navigation and
  // automatic activation (selection follows focus).
  const handleTabListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = visibleTabs.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight')
      nextIndex = (index + 1) % visibleTabs.length;
    else if (event.key === 'ArrowLeft')
      nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = visibleTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = visibleTabs[nextIndex];
    if (next !== tab) switchTab(next);
    document.getElementById(`m365-picker-tab-${next}`)?.focus();
  };

  const openFolder = (entry: M365DriveEntry) => {
    // Local cache hits render while a search is still in flight, so "came
    // from search" must cover the searching window too, not just results.
    const fromSearch = searchResults !== null || searching;
    cancelSearch();
    setSearchResults(null);
    setQuery('');
    const crumb: Crumb = {
      label: entry.name,
      driveId: entry.driveId,
      itemId: entry.itemId,
    };
    if (fromSearch) {
      // A search hit's real path is unknown (results span the whole drive),
      // so appending it to the browsed trail would fabricate a path. Keep
      // only the crumbs that scoped the search — SharePoint: site+library,
      // Teams: the team — and mark the gap elided (rendered as "…").
      const scope =
        tab === 'sharepoint'
          ? crumbs.slice(0, 2)
          : tab === 'teams'
            ? crumbs.slice(0, 1)
            : [];
      setCrumbs([...scope, { ...crumb, elided: true }]);
    } else {
      setCrumbs((prev) => [...prev, crumb]);
    }
  };

  const openTeam = (team: M365TeamEntry) => {
    cancelSearch();
    setQuery('');
    setErrorKey(null);
    setLoading(true);
    // Take over the listing explicitly: any still-pending load (e.g. the
    // teams-root list) must not be able to write state or clear the
    // loading shown while the team drive resolves.
    const seq = ++listSeqRef.current;
    getTeamDrive(team.groupId)
      .then((drive) => {
        if (seq !== listSeqRef.current) return;
        // The crumb carries the resolved drive; load() then browses its root.
        setCrumbs([{ label: team.name, driveId: drive.driveId }]);
      })
      .catch((error) => {
        if (seq !== listSeqRef.current) return;
        setLoading(false);
        setErrorKey(errorMessageKey(error));
      });
  };

  const rootLabel =
    tab === 'sharepoint'
      ? t('tabs.sharepoint')
      : tab === 'teams'
        ? t('tabs.teams')
        : t('tabs.onedrive');

  const pickFolderEntry = (entry: M365DriveEntry) => {
    onPickFolder?.({
      driveId: entry.driveId,
      itemId: entry.itemId,
      name: entry.name,
      pathLabel: [rootLabel, ...crumbLabels(crumbs), entry.name].join(' › '),
      // Picker trail: lets the next folder-mode opening start back here.
      tab,
      crumbs: [
        ...crumbs,
        { label: entry.name, driveId: entry.driveId, itemId: entry.itemId },
      ],
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
    const crumbPath = [rootLabel, ...crumbLabels(crumbs)].join(' › ');
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
    } else if (tab === 'teams' && crumbs[0]?.driveId) {
      // A team-drive root is addressable the same way as a SharePoint
      // library root (/drives/{d}/root:).
      currentDestination = {
        driveId: crumbs[0].driveId,
        itemId: lastCrumb?.itemId ?? null,
        name: lastCrumb?.label ?? '',
        pathLabel: crumbPath,
      };
    }
    if (currentDestination) {
      // Picker trail: lets the next folder-mode opening start back here.
      currentDestination = { ...currentDestination, tab, crumbs };
    }
  }

  const showSortPills =
    !searchActive &&
    (tab === 'onedrive' ||
      (tab === 'sharepoint' && sharePointPhase === 'browse') ||
      (tab === 'teams' && crumbs.length > 0));

  // Unlike sort (browse-only), the type filter also applies to recent,
  // shared and active search listings; folder mode has no files to filter.
  const showTypeFilter =
    !folderMode &&
    (tab === 'onedrive' ||
      tab === 'recent' ||
      tab === 'shared' ||
      (tab === 'sharepoint' && sharePointPhase === 'browse') ||
      (tab === 'teams' && crumbs.length > 0));

  // The active type-filter group's extension set; null = no filtering.
  const typeExtSet = useMemo(() => {
    const group = typeFilter ? getFileTypeGroup(typeFilter) : undefined;
    return group ? new Set(group.extensions) : null;
  }, [typeFilter]);
  // Browse listings keep folders (they are the navigation); search results
  // drop them — a type filter there means "show me files of this kind".
  const passesTypeFilter = useCallback(
    (entry: M365DriveEntry, keepFolders: boolean): boolean => {
      if (!typeExtSet) return true;
      if (entry.isFolder) return keepFolders;
      return typeExtSet.has(fileExtension(entry.name));
    },
    [typeExtSet],
  );

  const rawListedEntries = searchActive ? searchResults.entries : entries;
  const listedEntries = useMemo(
    () =>
      typeExtSet
        ? rawListedEntries.filter((entry) =>
            passesTypeFilter(entry, !searchActive),
          )
        : rawListedEntries,
    [rawListedEntries, typeExtSet, passesTypeFilter, searchActive],
  );
  const trimmedQuery = query.trim();

  // Search mode is sectioned: instant local hits (session cache) while the
  // server answers, then guaranteed name matches, then content matches.
  const searchMode = searchActive || searching;
  const serverKeys = useMemo(
    () =>
      new Set(
        (searchActive ? searchResults.entries : []).map(
          (e) => `${e.driveId}/${e.itemId}`,
        ),
      ),
    [searchActive, searchResults],
  );
  const localHits = useMemo(
    () =>
      searchMode && trimmedQuery.length >= SEARCH_MIN_CHARS
        ? queryDriveNameCache(trimmedQuery).filter(
            (e) =>
              !serverKeys.has(`${e.driveId}/${e.itemId}`) &&
              passesTypeFilter(e, false),
          )
        : [],
    [searchMode, trimmedQuery, serverKeys, passesTypeFilter],
  );
  // listedEntries is already type-filtered, so the sections inherit it.
  const nameMatches = searchActive
    ? listedEntries.filter((e) => e.match === 'name')
    : [];
  const contentMatches = searchActive
    ? listedEntries.filter((e) => e.match === 'content')
    : [];
  // Continuation pages come back untiered (the server deliberately doesn't
  // re-classify page 2+), so a missing `match` must not masquerade as a
  // content match — those entries get a neutral trailing section instead.
  const untieredMatches = searchActive
    ? listedEntries.filter((e) => e.match === undefined)
    : [];

  // Shared-foundation file-type filter: folders always navigate; files
  // outside the accepted set stay visible for orientation but are inert.
  const acceptSet = useMemo(
    () =>
      acceptExtensions && !folderMode
        ? new Set(acceptExtensions.map((ext) => ext.toLowerCase()))
        : null,
    [acceptExtensions, folderMode],
  );
  const isAccepted = (entry: M365DriveEntry): boolean => {
    if (!acceptSet || entry.isFolder) return true;
    const dot = entry.name.lastIndexOf('.');
    return dot > 0 && acceptSet.has(entry.name.slice(dot + 1).toLowerCase());
  };

  // Shared by the site browse sections and the site search results.
  const renderSiteRow = (site: M365SiteEntry) => (
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
        <IconBrandOnedrive size={18} className="flex-shrink-0 text-blue-500" />
        <span className="truncate">{site.name}</span>
      </button>
    </li>
  );
  const siteSectionHeader = (labelKey: string) => (
    <li
      key={`site-header-${labelKey}`}
      className="sticky top-0 z-10 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-neutral-900 dark:text-gray-400"
    >
      {t(labelKey)}
    </li>
  );

  return (
    <div className="flex h-[420px] flex-col gap-3">
      {/* Tabs */}
      <div
        className="flex gap-1 rounded-lg bg-gray-100 p-1 dark:bg-neutral-700/50"
        role="tablist"
        onKeyDown={handleTabListKeyDown}
      >
        {visibleTabs.map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            id={`m365-picker-tab-${candidate}`}
            aria-selected={tab === candidate}
            aria-controls="m365-picker-panel"
            tabIndex={tab === candidate ? 0 : -1}
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
                } else if (event.key === 'ArrowDown') {
                  // Jump from the query straight into the result list.
                  if (focusListButton(1)) event.preventDefault();
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
            className="flex items-center gap-1 hover:text-blue-600 hover:underline dark:hover:text-blue-400"
          >
            <IconHome size={12} />
            {rootLabel}
          </button>
          {crumbs.map((crumb, index) => (
            <span
              key={`${crumb.label}-${index}`}
              className="flex items-center gap-1"
            >
              <IconChevronRight size={12} />
              {/* Folders opened from search have no known path; an inert
                  "…" marks the gap instead of fabricating one. */}
              {crumb.elided && (
                <>
                  <span title={t('pathUnknown')}>…</span>
                  <IconChevronRight size={12} />
                </>
              )}
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

      {/* Type-filter chips (all file listings) + sort pills (children
          listings only — Graph rejects $orderby on recent/shared/search). */}
      {(showTypeFilter || showSortPills) && (
        <div className="flex items-center justify-between gap-2">
          {showTypeFilter ? (
            <div
              className="flex gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-neutral-700/50"
              role="group"
              aria-label={t('typeFilter.label')}
            >
              {M365_PRIMARY_FILE_TYPE_IDS.map((id) => {
                const [Icon, colorClass] = TYPE_FILTER_ICONS[id];
                const active = typeFilter === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={active}
                    aria-label={t(`typeFilter.${id}`)}
                    title={t(`typeFilter.${id}`)}
                    onClick={() => {
                      setTypeFilter(active ? null : id);
                      setTypeMenuOpen(false);
                    }}
                    className={`rounded-md px-1.5 py-1 transition-colors ${
                      active
                        ? 'bg-white shadow-sm dark:bg-neutral-800'
                        : 'opacity-60 hover:bg-white/60 hover:opacity-100 dark:hover:bg-neutral-800/60'
                    }`}
                  >
                    <Icon size={16} className={colorClass} aria-hidden="true" />
                  </button>
                );
              })}
              {(() => {
                // "…" menu for the remaining groups; when one of them is
                // active its icon replaces the dots so the state stays
                // visible without any text.
                const activeMore =
                  typeFilter && MORE_FILE_TYPE_IDS.includes(typeFilter)
                    ? typeFilter
                    : null;
                const [MoreIcon, moreColor] = activeMore
                  ? TYPE_FILTER_ICONS[activeMore]
                  : [IconDots, 'text-gray-500 dark:text-gray-400'];
                return (
                  <div ref={typeMenuRef} className="relative">
                    <button
                      type="button"
                      ref={typeMenuButtonRef}
                      aria-haspopup="menu"
                      aria-expanded={typeMenuOpen}
                      aria-pressed={activeMore !== null}
                      aria-label={t('typeFilter.more')}
                      title={
                        activeMore
                          ? t(`typeFilter.${activeMore}`)
                          : t('typeFilter.more')
                      }
                      onClick={() => setTypeMenuOpen((prev) => !prev)}
                      className={`rounded-md px-1.5 py-1 transition-colors ${
                        activeMore
                          ? 'bg-white shadow-sm dark:bg-neutral-800'
                          : 'opacity-60 hover:bg-white/60 hover:opacity-100 dark:hover:bg-neutral-800/60'
                      }`}
                    >
                      <MoreIcon
                        size={16}
                        className={moreColor}
                        aria-hidden="true"
                      />
                    </button>
                    {typeMenuOpen && (
                      <div
                        role="menu"
                        aria-label={t('typeFilter.more')}
                        className="absolute left-0 top-full z-20 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
                      >
                        {MORE_FILE_TYPE_IDS.map((id) => {
                          const [Icon, colorClass] = TYPE_FILTER_ICONS[id];
                          const active = typeFilter === id;
                          return (
                            <button
                              key={id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={active}
                              onClick={() => {
                                setTypeFilter(active ? null : id);
                                setTypeMenuOpen(false);
                              }}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                                active
                                  ? 'bg-gray-100 font-medium text-gray-900 dark:bg-neutral-700/50 dark:text-gray-100'
                                  : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-neutral-700/50'
                              }`}
                            >
                              <Icon
                                size={16}
                                className={`flex-shrink-0 ${colorClass}`}
                                aria-hidden="true"
                              />
                              {t(`typeFilter.${id}`)}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          ) : (
            <span />
          )}
          {showSortPills && (
            <div className="flex min-w-0 items-center gap-2">
              {/* Truthful sort UI: when the tenant rejected the $orderby the
                  rows are in raw Graph order, so no pill may claim to be
                  active and a note says why. */}
              {sortUnavailable && (
                <span className="min-w-0 truncate text-[11px] text-gray-400 dark:text-gray-500">
                  {t('sort.notApplied')}
                </span>
              )}
              <div
                className="flex flex-shrink-0 gap-1 rounded-lg bg-gray-100 p-0.5 dark:bg-neutral-700/50"
                role="group"
                aria-label={t('sort.label')}
              >
                {SORT_FIELDS.map((field) => {
                  const active = sort === field && !sortUnavailable;
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
        </div>
      )}

      {/* Content */}
      <div
        ref={listRef}
        onKeyDown={handleListKeyDown}
        id="m365-picker-panel"
        role="tabpanel"
        aria-labelledby={`m365-picker-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700"
      >
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <IconLoader2 size={16} className="animate-spin" />
            {t('loading')}
          </div>
        ) : errorKey ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-amber-700 dark:text-amber-400">
            <span>{t(errorKey)}</span>
            {/* Consent/connection failures are fixable in Settings →
                Connections; there is no section deep-link mechanism, so the
                CTA opens Settings and the label names the section. */}
            {(errorKey === 'errors.consentMissing' ||
              errorKey === 'errors.notConnected') && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  useUIStore.getState().setIsSettingsOpen(true);
                }}
                className="rounded-md border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/20"
              >
                {t('errors.openConnections')}
              </button>
            )}
          </div>
        ) : tab === 'teams' && crumbs.length === 0 ? (
          teams.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {t('teamsEmpty')}
            </div>
          ) : (
            <ul>
              {teams.map((team) => (
                <li key={team.groupId}>
                  <button
                    type="button"
                    onClick={() => openTeam(team)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-neutral-700/50"
                  >
                    <IconUsersGroup
                      size={18}
                      className="flex-shrink-0 text-violet-500"
                    />
                    <span className="truncate">{team.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : tab === 'sharepoint' && sharePointPhase === 'sites' ? (
          sites.length === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {/* A completed search with zero hits is a no-results state,
                  not an invitation to start searching. */}
              {sitesSearched && trimmedQuery.length >= SEARCH_MIN_CHARS
                ? t('sitesNoResults', { query: trimmedQuery })
                : t('sitesHint')}
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
        ) : listedEntries.length === 0 &&
          localHits.length === 0 &&
          // With a type filter and more pages available, fall through to the
          // list branch: its sentinel keeps auto-loading pages until a
          // matching file (or the end of the folder) turns up.
          !(typeExtSet && activeNextToken) ? (
          typeExtSet && rawListedEntries.length > 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-gray-500 dark:text-gray-400">
              <IconFilterOff size={24} className="text-gray-400" />
              {t('typeFilter.noMatches')}
              <button
                type="button"
                onClick={() => setTypeFilter(null)}
                className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
              >
                {t('typeFilter.all')}
              </button>
            </div>
          ) : searchActive ? (
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
            {(() => {
              const renderRow = (entry: M365DriveEntry) => (
                <li key={`${entry.driveId}-${entry.itemId}`}>
                  <div className="flex items-center">
                    {/* Attach mode gets a selection column: a checkbox for
                      files, an empty spacer for folders so icons align. */}
                    {attachMode &&
                      (!entry.isFolder && isAccepted(entry) ? (
                        <input
                          type="checkbox"
                          checked={selected.has(entryKey(entry))}
                          onChange={() => toggleSelected(entry)}
                          aria-label={t('selectEntry', { name: entry.name })}
                          className="ml-3 h-4 w-4 flex-shrink-0 accent-blue-600"
                        />
                      ) : (
                        <span className="ml-3 h-4 w-4 flex-shrink-0" />
                      ))}
                    {/* Folder mode and type-filtered pickers keep file rows
                      visible for orientation but inert — only folders (and
                      accepted files) respond. */}
                    <button
                      type="button"
                      disabled={
                        (folderMode || !isAccepted(entry)) && !entry.isFolder
                      }
                      title={
                        !entry.isFolder && !isAccepted(entry)
                          ? t('unsupportedType')
                          : undefined
                      }
                      onClick={() => {
                        if (entry.isFolder) return openFolder(entry);
                        if (folderMode || !isAccepted(entry)) return;
                        // With a selection in progress, row clicks grow the
                        // selection instead of instantly attaching — no
                        // accidental single-file attach mid-batch.
                        if (attachMode && selected.size > 0)
                          return toggleSelected(entry);
                        pickFile(entry);
                      }}
                      className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm text-gray-800 dark:text-gray-200 ${
                        (folderMode || !isAccepted(entry)) && !entry.isFolder
                          ? 'cursor-default opacity-50'
                          : 'hover:bg-gray-100 dark:hover:bg-neutral-700/50'
                      }`}
                    >
                      <M365FileTypeIcon entry={entry} size={18} />
                      <span className="min-w-0 flex-1" title={entry.name}>
                        <span className="block truncate">{entry.name}</span>
                        {/* Mixed-source listings (search spans every site;
                          recent/shared mix drives) show WHERE the item
                          lives — same-named files across sites are
                          indistinguishable otherwise. */}
                        {(searchMode || tab === 'recent' || tab === 'shared') &&
                          (entry.sourceLabel || entry.parentPath) && (
                            <span className="block truncate text-[11px] text-gray-400 dark:text-gray-500">
                              {[entry.sourceLabel, entry.parentPath]
                                .filter(Boolean)
                                .join(' › ')}
                            </span>
                          )}
                      </span>
                      <span className="hidden w-24 flex-shrink-0 text-right text-xs text-gray-400 sm:inline">
                        {entry.lastModified
                          ? dateFormatter.format(new Date(entry.lastModified))
                          : ''}
                      </span>
                      <span className="w-16 flex-shrink-0 text-right text-xs text-gray-400">
                        {entry.isFolder
                          ? entry.childCount !== undefined
                            ? t('itemCount', { count: entry.childCount })
                            : ''
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
              );
              if (!searchActive) {
                return listedEntries.map(renderRow);
              }
              const section = (labelKey: string, group: M365DriveEntry[]) =>
                group.length === 0
                  ? null
                  : [
                      <li
                        key={`header-${labelKey}`}
                        className="sticky top-0 z-10 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-neutral-900 dark:text-gray-400"
                      >
                        {t(labelKey)}
                      </li>,
                      ...group.map(renderRow),
                    ];
              return [
                section('sections.fromRecent', localHits),
                section('sections.nameMatches', nameMatches),
                section('sections.contentMatches', contentMatches),
                section('sections.moreResults', untieredMatches),
              ];
            })()}
            {/* Type filter emptied every loaded page but more pages exist:
                the sentinel below keeps auto-scanning, so say so — a big
                folder with no matches must not look like a bare spinner —
                and offer a way out of the scan. */}
            {typeExtSet &&
              activeNextToken &&
              !loadMoreFailed &&
              listedEntries.length === 0 &&
              localHits.length === 0 && (
                <li className="flex flex-col items-center gap-2 px-6 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                  <span className="flex items-center gap-2">
                    <IconLoader2 size={16} className="animate-spin" />
                    {t('typeFilter.scanning', {
                      count: rawListedEntries.length,
                    })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setTypeFilter(null)}
                    className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                  >
                    {t('typeFilter.all')}
                  </button>
                </li>
              )}
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

      {/* Attach-mode selection footer: appears once anything is checked.
          Selection survives navigation and tab switches, so a batch can be
          gathered from several folders before attaching. */}
      {attachMode && selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-gray-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
          <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-400">
            {t('selectedCount', { count: selected.size })}
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Map())}
            className="flex-shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
          >
            {t('clearSelection')}
          </button>
          <button
            type="button"
            onClick={attachSelected}
            className="flex-shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            {t('attachSelected', { count: selected.size })}
          </button>
        </div>
      )}

      {/* Folder-mode footer: outside the scroll container so it never
          competes with the load-more sentinel. Selects the folder being
          browsed; disabled wherever no addressable target exists (OneDrive
          root, SharePoint site/library phases). */}
      {folderMode && (
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-gray-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-800">
          <IconFolder size={18} className="flex-shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-400">
            {[rootLabel, ...crumbLabels(crumbs)].join(' › ')}
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
  acceptExtensions,
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
          acceptExtensions={acceptExtensions}
        />
      )}
    </Modal>
  );
};

export default M365FilePickerModal;
