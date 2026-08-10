import {
  IconAlertCircle,
  IconChevronDown,
  IconExternalLink,
  IconFlag,
  IconMail,
  IconMailOpened,
  IconMessages,
  IconPaperclip,
  IconPencil,
  IconSearch,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import {
  FC,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import {
  M365ClientError,
  M365_SEARCH_DEBOUNCE_MS,
  M365_SEARCH_MIN_CHARS,
  listMail,
} from '@/client/services/m365/m365Client';

import type { M365MailEnvelope, M365MailFilter } from '@/types/m365';

import Modal from '@/components/UI/Modal';

import { useChatInputStore } from '@/client/stores/chatInputStore';

interface M365MailImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = M365_SEARCH_DEBOUNCE_MS;
const MIN_QUERY_LENGTH = M365_SEARCH_MIN_CHARS;

// Flagged is deliberately absent (deferred: per-tenant $filter 400 risk);
// the row-level flag/importance markers remain pure $select display.
const CHIP_FILTERS: {
  filter: M365MailFilter;
  labelKey: string;
  Icon: typeof IconMail;
}[] = [
  { filter: 'unread', labelKey: 'filters.unread', Icon: IconMail },
  {
    filter: 'hasAttachments',
    labelKey: 'filters.hasAttachments',
    Icon: IconPaperclip,
  },
];

const AVATAR_COLORS = [
  'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
];

export type MailDateGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier';

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

function startOfLocalDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/** Whole local calendar days between `iso` and now (0 = today). */
function localDayAge(iso: string, now: Date): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Math.round(
    (startOfLocalDay(now) - startOfLocalDay(date)) / 86_400_000,
  );
}

/**
 * Compact relative time via Intl only (no i18n keys): time-of-day today,
 * weekday within the last 6 days, month+day this year, else full date.
 */
export function formatMailRowTime(
  iso: string | undefined,
  locale: string,
  now: Date = new Date(),
): string {
  if (!iso) return '';
  const age = localDayAge(iso, now);
  if (age === null) return '';
  const date = new Date(iso);
  if (age <= 0) {
    return date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (age <= 6) {
    return date.toLocaleDateString(locale, { weekday: 'short' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Local-midnight date bucket for the browse-mode group headers. */
export function mailDateGroup(
  iso: string | undefined,
  now: Date = new Date(),
): MailDateGroup {
  if (!iso) return 'earlier';
  const age = localDayAge(iso, now);
  if (age === null) return 'earlier';
  if (age <= 0) return 'today';
  if (age === 1) return 'yesterday';
  if (age <= 6) return 'thisWeek';
  return 'earlier';
}

export function senderInitials(
  envelope: Pick<M365MailEnvelope, 'fromName' | 'fromAddress' | 'from'>,
): string {
  const name = envelope.fromName?.trim();
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    const initials = `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`;
    if (initials) return initials.toUpperCase();
  }
  const fallback = envelope.fromAddress?.trim() || envelope.from.trim();
  return fallback ? fallback[0].toUpperCase() : '?';
}

/** Deterministic avatar color: same sender always hashes to the same pair. */
export function avatarColorClass(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

const COMPACT_BUTTON_CLASSES =
  'rounded-md border border-neutral-300 p-1 text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700';

const EXPANDED_BUTTON_CLASSES =
  'flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700';

const MailRow: FC<{
  envelope: M365MailEnvelope;
  expanded: boolean;
  onToggleExpand: () => void;
  onImport: (mode: 'message' | 'thread') => void;
  onSummarize: () => void;
  onDraftReply: () => void;
}> = ({
  envelope,
  expanded,
  onToggleExpand,
  onImport,
  onSummarize,
  onDraftReply,
}) => {
  const t = useTranslations('m365.mail');
  const locale = useLocale();
  const unread = envelope.isRead === false;
  const sender = envelope.fromName ?? envelope.fromAddress ?? envelope.from;

  return (
    <li className="group">
      <div className="grid grid-cols-[auto,minmax(0,1fr),auto] gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-neutral-800/60">
        <div className="relative h-8 w-8 flex-shrink-0">
          <span
            aria-hidden="true"
            className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ${avatarColorClass(envelope.fromAddress ?? envelope.from)}`}
          >
            {senderInitials(envelope)}
          </span>
          {unread && (
            <span className="absolute -left-0.5 -top-0.5 h-2 w-2 rounded-full bg-blue-600">
              <span className="sr-only">{t('unread')}</span>
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          className="min-w-0 cursor-pointer text-left"
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`truncate text-sm ${
                unread
                  ? 'font-semibold text-gray-900 dark:text-gray-100'
                  : 'font-medium text-gray-700 dark:text-gray-300'
              }`}
            >
              {sender}
            </span>
            {envelope.isFlagged && (
              <span className="flex-shrink-0" title={t('flagged')}>
                <IconFlag
                  size={13}
                  className="text-red-500"
                  aria-hidden="true"
                />
                <span className="sr-only">{t('flagged')}</span>
              </span>
            )}
            {envelope.importance === 'high' && (
              <span className="flex-shrink-0" title={t('importanceHigh')}>
                <IconAlertCircle
                  size={13}
                  className="text-orange-500"
                  aria-hidden="true"
                />
                <span className="sr-only">{t('importanceHigh')}</span>
              </span>
            )}
          </div>
          <div
            className={`truncate text-sm text-gray-800 dark:text-gray-200 ${unread ? 'font-medium' : ''}`}
          >
            {envelope.subject}
          </div>
          {envelope.preview && (
            <div className="line-clamp-1 text-xs text-gray-500 dark:text-gray-500">
              {envelope.preview}
            </div>
          )}
        </button>

        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            <span className="whitespace-nowrap text-xs text-gray-500 dark:text-gray-400">
              {formatMailRowTime(envelope.received, locale)}
            </span>
            {envelope.hasAttachments && (
              <span title={t('hasAttachmentsBadge')}>
                <IconPaperclip
                  size={13}
                  className="text-gray-400"
                  aria-hidden="true"
                />
                <span className="sr-only">{t('hasAttachmentsBadge')}</span>
              </span>
            )}
          </div>
          {/* Kept visible (opacity, never display:none) so they stay
              keyboard-reachable in the natural tab order. */}
          <div className="flex gap-1 opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              onClick={() => onImport('message')}
              title={t('importMessage')}
              aria-label={t('importMessage')}
              className={COMPACT_BUTTON_CLASSES}
            >
              <IconMailOpened size={14} />
            </button>
            {envelope.conversationId && (
              <button
                type="button"
                onClick={() => onImport('thread')}
                title={t('importThread')}
                aria-label={t('importThread')}
                className={COMPACT_BUTTON_CLASSES}
              >
                <IconMessages size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onToggleExpand}
              aria-expanded={expanded}
              title={expanded ? t('hideDetails') : t('showDetails')}
              aria-label={expanded ? t('hideDetails') : t('showDetails')}
              className={COMPACT_BUTTON_CLASSES}
            >
              <IconChevronDown
                size={14}
                className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="space-y-1 pb-2 pl-[52px] pr-3">
          {envelope.preview && (
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
              {envelope.preview}
            </p>
          )}
          {envelope.to && (
            <p
              className="truncate text-xs text-gray-500 dark:text-gray-400"
              title={envelope.to}
            >
              <span className="font-medium">{t('toLabel')}</span> {envelope.to}
            </p>
          )}
          {envelope.cc && (
            <p
              className="truncate text-xs text-gray-500 dark:text-gray-400"
              title={envelope.cc}
            >
              <span className="font-medium">{t('ccLabel')}</span> {envelope.cc}
            </p>
          )}
          {envelope.webLink && (
            <a
              href={envelope.webLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              <IconExternalLink size={14} />
              {t('openInOutlook')}
            </a>
          )}
          {/* The expanded state is the action surface: full-size labeled
              buttons (the collapsed row keeps compact icons only). */}
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            <button
              type="button"
              onClick={() => onImport('message')}
              className={EXPANDED_BUTTON_CLASSES}
            >
              <IconMailOpened size={15} />
              {t('message')}
            </button>
            {envelope.conversationId && (
              <button
                type="button"
                onClick={() => onImport('thread')}
                className={EXPANDED_BUTTON_CLASSES}
              >
                <IconMessages size={15} />
                {t('thread')}
              </button>
            )}
            <button
              type="button"
              onClick={onSummarize}
              title={t('actions.summarizeHint')}
              className={EXPANDED_BUTTON_CLASSES}
            >
              <IconSparkles size={15} />
              {t('actions.summarize')}
            </button>
            <button
              type="button"
              onClick={onDraftReply}
              title={t('actions.draftReplyHint')}
              className={EXPANDED_BUTTON_CLASSES}
            >
              <IconPencil size={15} />
              {t('actions.draftReply')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
};

/**
 * Search the user's mailbox and import a message — or its whole thread — as
 * a markdown conversation attachment. Read-only: attachment contents are
 * never fetched (the imported document lists their names), and nothing is
 * written back to the mailbox.
 */
const M365MailImportBody: FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useTranslations('m365.mail');
  const { attachMail } = useM365Attachment();

  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [filters, setFilters] = useState<M365MailFilter[]>([]);
  const [envelopes, setEnvelopes] = useState<M365MailEnvelope[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const seenIdsRef = useRef<Set<string>>(new Set());
  const sequenceRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const searchMode = activeQuery !== '';

  // Debounced search-as-you-type: queries settle after 300ms; anything
  // shorter than 2 chars settles back to browse mode.
  useEffect(() => {
    const trimmed = query.trim();
    const settled = trimmed.length >= MIN_QUERY_LENGTH ? trimmed : '';
    if (settled === activeQuery) return;
    const timer = setTimeout(() => setActiveQuery(settled), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, activeQuery]);

  // One fetch per settled request shape (the key encodes the whole request).
  // In search mode chip toggles filter the loaded results locally, so they
  // deliberately don't change the key and don't refetch.
  const requestKey = searchMode ? `q:${activeQuery}` : `f:${filters.join(',')}`;

  const loadFirstPage = useCallback(async () => {
    const value = requestKey.slice(2);
    const q = requestKey.startsWith('q:') ? value : '';
    const browseFilters =
      !q && value ? (value.split(',') as M365MailFilter[]) : [];
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const sequence = ++sequenceRef.current;
    setErrorKey(null);
    setLoading(true);
    setLoadingMore(false);
    setLoadMoreFailed(false);
    try {
      const page = await listMail({
        ...(q ? { q } : {}),
        ...(browseFilters.length > 0 ? { filters: browseFilters } : {}),
        signal: controller.signal,
      });
      if (sequence !== sequenceRef.current) return;
      const seen = new Set<string>();
      const deduped: M365MailEnvelope[] = [];
      for (const envelope of page.envelopes) {
        if (seen.has(envelope.id)) continue;
        seen.add(envelope.id);
        deduped.push(envelope);
      }
      seenIdsRef.current = seen;
      setEnvelopes(deduped);
      setNextToken(page.nextToken);
      setExpandedId(null);
    } catch (error) {
      if (isAbortError(error)) return; // superseded — a newer request owns the UI
      if (sequence !== sequenceRef.current) return;
      setEnvelopes([]);
      setNextToken(undefined);
      setErrorKey(errorMessageKey(error));
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
    }
  }, [requestKey]);

  useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore || loading) return;
    const sequence = sequenceRef.current;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const page = await listMail({ pageToken: nextToken });
      if (sequence !== sequenceRef.current) return;
      const fresh = page.envelopes.filter(
        (envelope) => !seenIdsRef.current.has(envelope.id),
      );
      fresh.forEach((envelope) => seenIdsRef.current.add(envelope.id));
      setEnvelopes((prev) => [...prev, ...fresh]);
      // Graph $search paging can hand back already-seen pages; a page that
      // contributes nothing new terminates pagination.
      setNextToken(fresh.length === 0 ? undefined : page.nextToken);
      setLoadingMore(false);
    } catch (error) {
      if (isAbortError(error)) return;
      if (sequence !== sequenceRef.current) return;
      setLoadingMore(false);
      setLoadMoreFailed(true);
    }
  }, [nextToken, loadingMore, loading]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);
  const showSentinel = !loading && !errorKey && !loadMoreFailed && !!nextToken;

  useEffect(() => {
    if (!showSentinel) return;
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === 'undefined') {
      return;
    }
    // Root must be the scroll container — against the viewport the sentinel
    // is "visible" the moment the modal opens.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMoreRef.current();
        }
      },
      { root, rootMargin: '80px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [showSentinel]);

  // Search results are filtered locally: Graph can't combine $search with
  // $filter, so chips narrow whatever pages are loaded so far.
  const displayed = useMemo(() => {
    if (!searchMode || filters.length === 0) return envelopes;
    return envelopes.filter((envelope) =>
      filters.every((filter) =>
        filter === 'unread'
          ? envelope.isRead === false
          : filter === 'hasAttachments'
            ? envelope.hasAttachments
            : envelope.isFlagged === true,
      ),
    );
  }, [envelopes, searchMode, filters]);

  // Group headers are browse-only (search results are relevance-ordered —
  // date grouping would misrepresent the order) and span all loaded pages.
  const listItems = useMemo(
    () =>
      displayed.map((envelope, index) => {
        if (searchMode) {
          return { envelope, header: null as MailDateGroup | null };
        }
        const group = mailDateGroup(envelope.received);
        const previous =
          index > 0 ? mailDateGroup(displayed[index - 1].received) : null;
        return { envelope, header: group !== previous ? group : null };
      }),
    [displayed, searchMode],
  );

  const toggleFilter = (filter: M365MailFilter) => {
    setFilters((prev) =>
      prev.includes(filter)
        ? prev.filter((f) => f !== filter)
        : [...prev, filter],
    );
  };

  const importMail = (
    envelope: M365MailEnvelope,
    mode: 'message' | 'thread',
  ) => {
    // Continues in the background; progress shows on the attachment tile.
    void attachMail(envelope, mode);
    onClose();
  };

  /**
   * Context actions: attach the mail AND pre-fill the composer with the
   * matching prompt — never auto-sent, same posture as playbooks. The
   * draft-reply prompt carries the message id so the reply tool (when the
   * toolset is on) can target the real thread.
   */
  const importWithPrompt = (
    envelope: M365MailEnvelope,
    mode: 'message' | 'thread',
    prompt: string,
  ) => {
    void attachMail(envelope, mode);
    useChatInputStore
      .getState()
      .setTextFieldValue((prev) =>
        prev.trim() ? `${prev}\n\n${prompt}` : prompt,
      );
    onClose();
  };

  const summarizeMail = (envelope: M365MailEnvelope) => {
    importWithPrompt(
      envelope,
      envelope.conversationId ? 'thread' : 'message',
      t('prompts.summarize'),
    );
  };

  const draftReply = (envelope: M365MailEnvelope) => {
    importWithPrompt(
      envelope,
      'message',
      t('prompts.draftReply', { id: envelope.id }),
    );
  };

  const emptyKey =
    searchMode && envelopes.length > 0
      ? 'emptyFiltered'
      : searchMode
        ? 'emptySearch'
        : filters.length > 0
          ? 'emptyFiltered'
          : 'empty';

  return (
    <div className="flex h-[min(70vh,600px)] flex-col gap-2">
      <div className="relative">
        <IconSearch
          size={16}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
        />
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              // First Escape clears the query; the next one closes the modal.
              e.preventDefault();
              e.stopPropagation();
              setQuery('');
            }
          }}
          placeholder={t('searchPlaceholder')}
          className="w-full rounded-lg border border-gray-300 bg-gray-50 py-1.5 pl-8 pr-8 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('clearSearch')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {CHIP_FILTERS.map(({ filter, labelKey, Icon }) => {
          const selected = filters.includes(filter);
          return (
            <button
              key={filter}
              type="button"
              aria-pressed={selected}
              onClick={() => toggleFilter(filter)}
              className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                selected
                  ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-500 dark:bg-blue-500'
                  : 'border-neutral-300 text-gray-600 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700'
              }`}
            >
              <Icon size={13} />
              {t(labelKey)}
            </button>
          );
        })}
        {searchMode && filters.length > 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('filtersLocalHint')}
          </span>
        )}
      </div>

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
        ) : displayed.length === 0 ? (
          // More pages may still hold matches when chips filter locally, so
          // the empty state keeps pagination alive instead of dead-ending.
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            {t(emptyKey)}
            {loadingMore ? (
              <span className="text-xs">{t('loadingMore')}</span>
            ) : loadMoreFailed ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
              >
                {t('retry')}
              </button>
            ) : nextToken ? (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
              >
                {t('loadMoreMatches')}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-700/50">
              {listItems.map(({ envelope, header }) => (
                <Fragment key={envelope.id}>
                  {header && (
                    <li className="sticky top-0 z-10 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-surface-dark-base dark:text-gray-400">
                      {t(`groups.${header}`)}
                    </li>
                  )}
                  <MailRow
                    envelope={envelope}
                    expanded={expandedId === envelope.id}
                    onToggleExpand={() =>
                      setExpandedId((prev) =>
                        prev === envelope.id ? null : envelope.id,
                      )
                    }
                    onImport={(mode) => importMail(envelope, mode)}
                    onSummarize={() => summarizeMail(envelope)}
                    onDraftReply={() => draftReply(envelope)}
                  />
                </Fragment>
              ))}
            </ul>
            {loadingMore && (
              <div className="flex items-center justify-center py-3 text-xs text-gray-500 dark:text-gray-400">
                {t('loadingMore')}
              </div>
            )}
            {loadMoreFailed && !loadingMore && (
              <div className="flex items-center justify-center gap-2 py-3 text-xs text-amber-700 dark:text-amber-400">
                {t('loadMoreError')}
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                >
                  {t('retry')}
                </button>
              </div>
            )}
            {showSentinel && (
              <div ref={sentinelRef} className="h-px" aria-hidden="true" />
            )}
          </>
        )}
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-500">
        {t('attachmentsNotImported')}
      </p>
    </div>
  );
};

const M365MailImportModal: FC<M365MailImportModalProps> = ({
  isOpen,
  onClose,
}) => {
  const t = useTranslations('m365.mail');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      icon={<IconMail size={20} />}
      size="lg"
    >
      {isOpen && <M365MailImportBody onClose={onClose} />}
    </Modal>
  );
};

export default M365MailImportModal;
