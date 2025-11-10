import {
  IconBlockquote,
  IconChevronDown,
  IconChevronUp,
} from '@tabler/icons-react';
import React, { FC, MouseEvent, useEffect, useRef, useState } from 'react';

import { Citation } from '@/types/rag';

import { CitationItem } from './CitationItem';

interface CitationListProps {
  citations: Citation[];
}

export const CitationList: FC<{ citations: Citation[] }> = ({ citations }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
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

  if (uniqueCitations.length === 0) return null;

  return (
    <div
      className={`mt-4 mb-3 w-full transition-opacity duration-500 ease-in-out ${
        isVisible ? 'opacity-100' : 'opacity-0'
      }`}
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
        <div className="ml-auto text-gray-500 dark:text-gray-400 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors duration-200">
          {isExpanded ? (
            <IconChevronUp size={18} />
          ) : (
            <IconChevronDown size={18} />
          )}
        </div>
      </div>

      <div
        className={`overflow-hidden transition-all duration-300 ease-in-out ${
          isExpanded ? 'max-h-[200px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div
          ref={scrollContainerRef}
          className="flex w-full overflow-x-auto gap-4 no-scrollbar pt-5"
          style={{ scrollBehavior: 'auto' }}
          onMouseMove={handleReactMouseMove}
          onMouseLeave={handleReactMouseLeave}
        >
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
    </div>
  );
};
