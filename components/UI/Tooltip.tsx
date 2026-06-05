'use client';

import { ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  /**
   * When true, allows the tooltip content to wrap across multiple lines and
   * constrains its width. Default behavior keeps a single line.
   *
   * Multiline tooltips are rendered in a portal with fixed positioning and are
   * clamped to the viewport so long (e.g. translated) strings can never be
   * clipped at a container or screen edge.
   */
  multiline?: boolean;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 8;

export function Tooltip({
  content,
  children,
  position = 'top',
  multiline = false,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null,
  );

  // Position + clamp the multiline tooltip against the viewport. Runs on show
  // and while visible on scroll/resize so it never ends up clipped at an edge.
  useLayoutEffect(() => {
    if (!isVisible || !multiline) return;

    const computePosition = () => {
      const trigger = wrapperRef.current;
      const tip = tooltipRef.current;
      if (!trigger || !tip) return;

      const t = trigger.getBoundingClientRect();
      const box = tip.getBoundingClientRect();

      let left: number;
      let top: number;
      switch (position) {
        case 'bottom':
          left = t.left + t.width / 2 - box.width / 2;
          top = t.bottom + TRIGGER_GAP;
          break;
        case 'left':
          left = t.left - box.width - TRIGGER_GAP;
          top = t.top + t.height / 2 - box.height / 2;
          break;
        case 'right':
          left = t.right + TRIGGER_GAP;
          top = t.top + t.height / 2 - box.height / 2;
          break;
        case 'top':
        default:
          left = t.left + t.width / 2 - box.width / 2;
          top = t.top - box.height - TRIGGER_GAP;
          break;
      }

      const maxLeft = window.innerWidth - box.width - VIEWPORT_MARGIN;
      const maxTop = window.innerHeight - box.height - VIEWPORT_MARGIN;
      left = Math.min(
        Math.max(VIEWPORT_MARGIN, left),
        Math.max(VIEWPORT_MARGIN, maxLeft),
      );
      top = Math.min(
        Math.max(VIEWPORT_MARGIN, top),
        Math.max(VIEWPORT_MARGIN, maxTop),
      );

      setCoords({ left, top });
    };

    computePosition();
    window.addEventListener('scroll', computePosition, true);
    window.addEventListener('resize', computePosition);
    return () => {
      window.removeEventListener('scroll', computePosition, true);
      window.removeEventListener('resize', computePosition);
    };
  }, [isVisible, multiline, position, content]);

  const show = () => setIsVisible(true);
  const hide = () => {
    setIsVisible(false);
    setCoords(null);
  };

  const positionClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  const arrowClasses = {
    top: 'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-gray-900 dark:border-t-gray-700',
    bottom:
      'bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-gray-900 dark:border-b-gray-700',
    left: 'left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-gray-900 dark:border-l-gray-700',
    right:
      'right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-gray-900 dark:border-r-gray-700',
  };

  return (
    <div
      ref={wrapperRef}
      className="relative inline-block"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {isVisible && !multiline && (
        <div
          className={`absolute z-50 whitespace-nowrap px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded shadow-lg pointer-events-none animate-in fade-in zoom-in-95 duration-200 ${positionClasses[position]}`}
        >
          {content}
          <div
            className={`absolute w-0 h-0 border-4 ${arrowClasses[position]}`}
          />
        </div>
      )}
      {isVisible &&
        multiline &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tooltipRef}
            className="fixed z-[10003] whitespace-normal max-w-xs leading-snug px-2 py-1 text-xs font-medium text-white bg-gray-900 dark:bg-gray-700 rounded shadow-lg pointer-events-none animate-in fade-in zoom-in-95 duration-200"
            style={{
              left: coords?.left ?? 0,
              top: coords?.top ?? 0,
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </div>
  );
}
