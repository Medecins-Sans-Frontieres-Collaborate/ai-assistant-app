import { RefObject, useEffect, useRef } from 'react';

/** Selector for elements that can receive keyboard focus */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * useModal
 *
 * A comprehensive hook for modal behavior that handles:
 * - Outside clicks to close the modal
 * - Escape key press to close the modal
 * - Focus trapping within the modal
 * - Restoring focus to the previously focused element on close
 * - Preventing scroll on body when modal is open
 * - cleanup on unmount
 *
 * @param isOpen - Boolean indicating if the modal is open
 * @param onClose - Callback function to close the modal
 * @param preventOutsideClick - Optional boolean to disable outside click behavior
 * @param preventEscapeKey - Optional boolean to disable escape key behavior
 * @returns A ref object to be attached to the modal content container
 */
const useModal = (
  isOpen: boolean,
  onClose: () => void,
  preventOutsideClick: boolean = false,
  preventEscapeKey: boolean = false,
): RefObject<HTMLDivElement | null> => {
  const modalRef = useRef<HTMLDivElement | null>(null);

  // Handle outside clicks
  useEffect(() => {
    if (!isOpen || preventOutsideClick) return;

    const handleClickOutside = (event: MouseEvent) => {
      // Check if the click was outside the modal content
      if (
        modalRef.current &&
        !modalRef.current.contains(event.target as Node)
      ) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };

    // Use a small timeout to prevent the handler from being called immediately
    // This fixes issues with button clicks that open the modal
    const timerID = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 10);

    return () => {
      clearTimeout(timerID);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, preventOutsideClick]);

  // Handle escape key press
  useEffect(() => {
    if (!isOpen || preventEscapeKey) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, preventEscapeKey]);

  // Trap Tab focus within the modal. Only engages while focus is inside the
  // modal so a stacked modal (e.g. one opened from settings) is not fought over.
  useEffect(() => {
    if (!isOpen) return;

    const handleTabKey = (event: KeyboardEvent) => {
      const modal = modalRef.current;
      if (event.key !== 'Tab' || !modal) return;

      const active = document.activeElement;
      if (!active || !modal.contains(active)) return;

      const focusable = modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) {
        // Nothing to cycle through; keep focus on the container
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleTabKey);

    return () => {
      document.removeEventListener('keydown', handleTabKey);
    };
  }, [isOpen]);

  // Restore focus to the element that was focused before the modal opened
  useEffect(() => {
    if (!isOpen) return;

    const previouslyFocused = document.activeElement;

    return () => {
      if (
        previouslyFocused instanceof HTMLElement &&
        document.contains(previouslyFocused)
      ) {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  // Prevent body scrolling when modal is open
  useEffect(() => {
    if (!isOpen) return;

    const originalStyle =
      window.getComputedStyle(document.body).overflow || 'visible';
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = originalStyle;
    };
  }, [isOpen]);

  return modalRef;
};

export default useModal;
