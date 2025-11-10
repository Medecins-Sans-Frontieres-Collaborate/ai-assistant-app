import { RefObject } from 'react';

/**
 * Calculates whether the scroll-down button should be shown
 * Based on how far the user has scrolled up from the bottom
 *
 * @param container - The scrollable container element
 * @param threshold - Distance in pixels from bottom to trigger showing button (default: 100)
 * @returns True if scroll button should be shown
 *
 * @example
 * const shouldShow = shouldShowScrollButton(containerRef.current);
 */
export const shouldShowScrollButton = (
  container: HTMLDivElement | null,
  threshold: number = 100,
): boolean => {
  if (!container) return false;

  const { scrollTop, scrollHeight, clientHeight } = container;
  const isScrolledUp = scrollHeight - scrollTop - clientHeight > threshold;

  return isScrolledUp;
};

/**
 * Scrolls an element to the bottom
 *
 * @param ref - Reference to the element to scroll
 * @param behavior - Scroll behavior ('smooth' or 'auto', default: 'smooth')
 *
 * @example
 * scrollToBottom(messagesEndRef, 'smooth');
 */
export const scrollToBottom = (
  ref: RefObject<HTMLElement | null>,
  behavior: ScrollBehavior = 'smooth',
): void => {
  if (ref.current) {
    ref.current.scrollIntoView({ behavior });
  }
};

/**
 * Checks if an element is scrolled to the bottom
 *
 * @param container - The scrollable container element
 * @param threshold - Margin of error in pixels (default: 10)
 * @returns True if scrolled to bottom (within threshold)
 */
export const isScrolledToBottom = (
  container: HTMLDivElement | null,
  threshold: number = 10,
): boolean => {
  if (!container) return true;

  const { scrollTop, scrollHeight, clientHeight } = container;
  return Math.abs(scrollHeight - scrollTop - clientHeight) <= threshold;
};
