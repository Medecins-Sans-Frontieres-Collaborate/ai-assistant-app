import {
  IconBlockquote,
  IconChevronDown,
  IconChevronUp,
  IconLayoutCards,
  IconList,
} from '@tabler/icons-react';
import React, {
  FC,
  MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Citation } from '@/types/rag';

import { CitationItem } from './CitationItem';
import { CitationListItem } from './CitationListItem';

interface CitationListProps {
  citations: Citation[];
}

export const CitationList: FC<{ citations: Citation[] }> = ({ citations }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('cards');
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollDirection, setScrollDirection] = useState<
    'left' | 'right' | null
  >(null);
  const scrollIntervalRef = useRef<number | null>(null);

  // Deduplicate citations by URL or title
  const uniqueCitations = citations.reduce((acc: Citation[], current) => {
    const isDuplicate = acc.some(
      (item) =>
        (item.url && current.url && item.url === current.url) ||
        (item.title && current.title && item.title === current.title),
    );

    if (!isDuplicate) {
      acc.push(current);
    }
    return acc;
  }, []);

  // Extract unique domains for header favicon display
  const uniqueDomainCitations = useMemo(() => {
    const seen = new Set<string>();
    return uniqueCitations.filter((c) => {
      try {
        const domain = new URL(c.url).hostname;
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
        className="flex items-center cursor-pointer group rounded-lg px-3.5 py-2 dark:bg-[#1a1a1a] bg-gray-50/80 border border-gray-200/60 dark:border-gray-700/40 transition-all duration-200 hover:border-blue-400/50 dark:hover:border-blue-500/40 hover:bg-gray-100/80 dark:hover:bg-[#222222]"
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
              {uniqueCitations.length > 1 ? 'Sources' : 'Source'}
            </span>
          </div>
        </div>

        {/* Header favicons showing unique source domains */}
        {visibleFavicons.length > 0 && (
          <div className="flex items-center gap-1 ml-3 pl-3 border-l border-gray-300 dark:border-gray-600">
            {visibleFavicons.map((citation) => {
              const hostname = new URL(citation.url).hostname;
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
              <span className="text-xs text-gray-500 dark:text-gray-400 ml-0.5">
                +{overflowCount}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-1 ml-auto">
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
              ? 'max-h-[200px] opacity-100'
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
              {uniqueCitations.map((citation, index) => (
                <div
                  key={citation.number || citation.url || index}
                  className="flex-shrink-0"
                >
                  <CitationItem citation={citation} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 pt-3 overflow-y-auto max-h-[350px]">
            {uniqueCitations.map((citation, index) => (
              <CitationListItem
                key={citation.number || citation.url || index}
                citation={citation}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
