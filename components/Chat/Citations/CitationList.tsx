import {
  IconBlockquote,
  IconChevronDown,
  IconChevronUp,
  IconFiles,
  IconLayoutCards,
  IconList,
  IconWorld,
} from '@tabler/icons-react';
import React, {
  FC,
  MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import {
  buildSourceCards,
  groupSourceCardsByOrigin,
} from '@/lib/utils/app/citationDisplay';

import { Citation, CitationOrigin } from '@/types/rag';

import { CitationItem } from './CitationItem';
import { CitationListItem } from './CitationListItem';

interface CitationListProps {
  citations: Citation[];
  /** Citation numbers that appear as [n] markers in the message text. */
  citedNumbers?: number[];
}

/**
 * Session-lifetime cache of resolved redirect links, shared across all
 * citation lists so re-renders and revisits never re-ask the server.
 */
const resolvedLinkCache = new Map<string, string>();

const GOOGLE_NEWS_LINK_RE =
  /^https:\/\/news\.google\.com\/(?:rss\/)?articles\//;

/**
 * Deferred link upgrading: Google News search responses stream immediately
 * with redirect links; this hook swaps in the real publisher URLs a moment
 * later via the authed resolve endpoint. Purely cosmetic-progressive — the
 * redirect links work regardless, and failures change nothing.
 */
function useResolvedCitationLinks(citations: Citation[]): Citation[] {
  const [resolvedVersion, setResolvedVersion] = useState(0);

  const unresolvedKey = citations
    .map((c) => c.url)
    .filter((u) => GOOGLE_NEWS_LINK_RE.test(u) && !resolvedLinkCache.has(u))
    .join('|');

  useEffect(() => {
    if (!unresolvedKey) return;
    const links = unresolvedKey.split('|').slice(0, 15);
    let cancelled = false;

    fetch('/api/search/resolve-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { resolved?: Record<string, string> } | null) => {
        if (cancelled || !data?.resolved) return;
        const entries = Object.entries(data.resolved);
        if (entries.length === 0) return;
        for (const [link, url] of entries) {
          resolvedLinkCache.set(link, url);
        }
        setResolvedVersion((v) => v + 1);
      })
      .catch(() => {
        // Best-effort: redirect links keep working.
      });

    return () => {
      cancelled = true;
    };
  }, [unresolvedKey]);

  return useMemo(
    () =>
      citations.map((citation) =>
        resolvedLinkCache.has(citation.url)
          ? { ...citation, url: resolvedLinkCache.get(citation.url)! }
          : citation,
      ),
    // resolvedVersion invalidates the memo when new resolutions land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [citations, resolvedVersion],
  );
}

/**
 * Heading above the sources of one origin ("Agent documents" / "Web").
 * The hint spells out what the origin means for readers who hover it.
 */
const OriginHeading: FC<{
  label: string;
  hint: string;
  origin: CitationOrigin;
}> = ({ label, hint, origin }) => {
  const Icon = origin === 'knowledge' ? IconFiles : IconWorld;
  return (
    <div
      className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400"
      title={hint}
      data-testid={`source-origin-${origin}`}
    >
      <Icon size={13} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
};

export const CitationList: FC<CitationListProps> = ({
  citations: rawCitations,
  citedNumbers,
}) => {
  const citations = useResolvedCitationLinks(rawCitations);
  const t = useTranslations('chat.sources');
  const [isExpanded, setIsExpanded] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('cards');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollDirection, setScrollDirection] = useState<
    'left' | 'right' | null
  >(null);
  const scrollIntervalRef = useRef<number | null>(null);

  // One card per source document: chunk-level citations of the same file
  // collapse, and when the message text tells us which numbers were
  // actually cited, the card lists each cited number's quote WITH its own
  // page locator (see buildSourceCards).
  const uniqueCitations = useMemo(
    () => buildSourceCards(citations, citedNumbers),
    [citations, citedNumbers],
  );

  // Documents of an agent and public web pages are listed under separate
  // headings, so a reader never has to infer a source's origin from its
  // domain. Messages stored before origins were recorded stay one flat list.
  const sourceGroups = useMemo(
    () => groupSourceCardsByOrigin(uniqueCitations),
    [uniqueCitations],
  );
  const originLabel = (origin: CitationOrigin): string =>
    origin === 'knowledge' ? t('fromDocuments') : t('fromWeb');
  const originHint = (origin: CitationOrigin): string =>
    origin === 'knowledge' ? t('fromDocumentsHint') : t('fromWebHint');
  const labelledGroups = sourceGroups.filter(
    (group) => group.origin !== undefined,
  );

  // Extract unique domains for header favicon display
  const uniqueDomainCitations = useMemo(() => {
    const seen = new Set<string>();
    return uniqueCitations.filter((c) => {
      try {
        const domain = new URL(c.sourceUrl || c.url).hostname;
        if (seen.has(domain)) return false;
        seen.add(domain);
        return true;
      } catch {
        return false;
      }
    });
  }, [uniqueCitations]);

  const MAX_HEADER_FAVICONS = 5;
  const visibleFavicons = uniqueDomainCitations.slice(0, MAX_HEADER_FAVICONS);
  const overflowCount = uniqueDomainCitations.length - MAX_HEADER_FAVICONS;

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), 100);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!scrollContainerRef.current) return;

      const container = scrollContainerRef.current;
      const containerRect = container.getBoundingClientRect();
      const mouseX = e.clientX - containerRect.left;
      const containerWidth = containerRect.width;

      if (mouseX > containerWidth * 0.9) {
        setScrollDirection('right');
      } else if (mouseX < containerWidth * 0.1) {
        setScrollDirection('left');
      } else {
        setScrollDirection(null);
      }
    };

    const handleMouseLeave = () => {
      setScrollDirection(null);
    };

    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener(
        'mousemove',
        handleMouseMove as unknown as EventListener,
      );
      container.addEventListener('mouseleave', handleMouseLeave);
    }

    return () => {
      if (container) {
        container.removeEventListener(
          'mousemove',
          handleMouseMove as unknown as EventListener,
        );
        container.removeEventListener('mouseleave', handleMouseLeave);
      }
    };
  }, []);

  useEffect(() => {
    const SCROLL_SPEED = 5; // Pixels per frame

    if (scrollDirection) {
      scrollIntervalRef.current = window.setInterval(() => {
        if (scrollContainerRef.current) {
          const container = scrollContainerRef.current;
          if (scrollDirection === 'right') {
            container.scrollLeft += SCROLL_SPEED;
          } else {
            container.scrollLeft -= SCROLL_SPEED;
          }
        }
      }, 16); // ~60fps
    } else {
      if (scrollIntervalRef.current !== null) {
        clearInterval(scrollIntervalRef.current);
        scrollIntervalRef.current = null;
      }
    }

    return () => {
      if (scrollIntervalRef.current !== null) {
        clearInterval(scrollIntervalRef.current);
      }
    };
  }, [scrollDirection]);

  const handleReactMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const mouseX = e.clientX - containerRect.left;
    const containerWidth = containerRect.width;

    if (mouseX > containerWidth * 0.9) {
      setScrollDirection('right');
    } else if (mouseX < containerWidth * 0.1) {
      setScrollDirection('left');
    } else {
      setScrollDirection(null);
    }
  };

  const handleReactMouseLeave = () => {
    setScrollDirection(null);
  };

  const toggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  const toggleViewMode = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setViewMode(viewMode === 'cards' ? 'list' : 'cards');
    // Auto-expand when toggling view mode if not already expanded
    if (!isExpanded) {
      setIsExpanded(true);
    }
  };

  if (uniqueCitations.length === 0) return null;

  return (
    <div
      className={`mt-4 mb-3 transition-opacity duration-500 ease-in-out ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
      style={{
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        overflow: 'hidden',
        contain: 'inline-size',
      }}
    >
      <div
        className="flex items-center cursor-pointer group rounded-lg px-3.5 py-2 dark:bg-surface-dark-recessed bg-gray-50/80 border border-gray-200/60 dark:border-gray-700/40 transition-all duration-200 hover:border-blue-400/50 dark:hover:border-blue-500/40 hover:bg-gray-100/80 dark:hover:bg-surface-dark"
        onClick={toggleExpand}
      >
        <div className="flex items-center gap-2">
          <IconBlockquote
            size={18}
            className="text-gray-600 dark:text-gray-400 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors duration-200"
          />
          <div className="flex items-center gap-1.5">
            <span className="font-semibold text-sm text-gray-700 dark:text-gray-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors duration-200">
              {uniqueCitations.length}
            </span>
            <span className="text-sm text-gray-600 dark:text-gray-400 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors duration-200">
              {t('heading', { count: uniqueCitations.length })}
            </span>
          </div>
          {labelledGroups.length > 1 && (
            <span
              className="text-xs text-gray-500 dark:text-gray-400"
              data-testid="source-origin-summary"
            >
              {labelledGroups
                .map(
                  (group) =>
                    `${originLabel(group.origin!)} ${group.cards.length}`,
                )
                .join(' · ')}
            </span>
          )}
        </div>

        {/* Header favicons showing unique source domains */}
        {visibleFavicons.length > 0 && (
          <div className="flex items-center gap-1 ms-3 ps-3 border-s border-gray-300 dark:border-gray-600">
            {visibleFavicons.map((citation) => {
              const hostname = new URL(citation.sourceUrl || citation.url)
                .hostname;
              const displayDomain = hostname.replace(/^www\./, '');
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={citation.url}
                  src={`https://www.google.com/s2/favicons?domain=${hostname}&size=16`}
                  alt={`${displayDomain}`}
                  title={displayDomain}
                  width={14}
                  height={14}
                  className="rounded-sm opacity-70 group-hover:opacity-100 transition-opacity duration-200"
                />
              );
            })}
            {overflowCount > 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400 ms-0.5">
                +{overflowCount}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-1 ms-auto">
          {/* View mode toggle button */}
          <button
            onClick={toggleViewMode}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors duration-200"
            title={
              viewMode === 'cards'
                ? 'Switch to list view'
                : 'Switch to card view'
            }
          >
            {viewMode === 'cards' ? (
              <IconList size={16} />
            ) : (
              <IconLayoutCards size={16} />
            )}
          </button>

          <div className="text-gray-500 dark:text-gray-400 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors duration-200">
            {isExpanded ? (
              <IconChevronUp size={18} />
            ) : (
              <IconChevronDown size={18} />
            )}
          </div>
        </div>
      </div>

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          isExpanded
            ? viewMode === 'cards'
              ? 'max-h-[270px] opacity-100'
              : 'max-h-[400px] opacity-100'
            : 'max-h-0 opacity-0'
        }`}
        style={{ width: '100%' }}
      >
        {viewMode === 'cards' ? (
          <div
            ref={scrollContainerRef}
            className="overflow-x-auto no-scrollbar pt-5"
            style={{ scrollBehavior: 'auto' }}
            onMouseMove={handleReactMouseMove}
            onMouseLeave={handleReactMouseLeave}
          >
            <div className="inline-flex gap-4">
              {sourceGroups.map((group, groupIndex) => (
                <div
                  key={group.origin ?? 'unlabelled'}
                  className={`flex flex-col gap-1.5 ${
                    groupIndex > 0
                      ? 'border-s border-gray-300 ps-4 dark:border-gray-600'
                      : ''
                  }`}
                >
                  {group.origin && (
                    <OriginHeading
                      label={originLabel(group.origin)}
                      hint={originHint(group.origin)}
                      origin={group.origin}
                    />
                  )}
                  <div className="inline-flex gap-4">
                    {group.cards.map((citation, index) => (
                      <div
                        key={citation.number || citation.url || index}
                        className="flex-shrink-0"
                      >
                        <CitationItem
                          citation={citation}
                          showOriginLabel={group.origin === undefined}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 pt-3 overflow-y-auto max-h-[350px]">
            {sourceGroups.map((group) => (
              <React.Fragment key={group.origin ?? 'unlabelled'}>
                {group.origin && (
                  <OriginHeading
                    label={originLabel(group.origin)}
                    hint={originHint(group.origin)}
                    origin={group.origin}
                  />
                )}
                {group.cards.map((citation, index) => (
                  <CitationListItem
                    key={citation.number || citation.url || index}
                    citation={citation}
                  />
                ))}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
