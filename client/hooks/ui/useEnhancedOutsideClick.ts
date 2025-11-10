import { RefObject, useEffect } from 'react';

/**
 * Enhanced useOutsideClick hook that provides better handling of outside clicks
 * with event capture phases and proper preventDefault/stopPropagation usage.
 *
 * This implementation specifically addresses issues with dropdowns and modals
 * that can have conflicting event handlers or bubbling issues.
 *
 * @param ref - A React ref pointing to the target HTML element
 * @param onOutsideClick - Callback function executed when a click outside the element is detected
 * @param isActive - Boolean to enable or disable the event listener
 * @param useCapture - Boolean to determine if event should be captured in capture phase (true) or bubble phase (false)
 */
const useEnhancedOutsideClick = (
  ref: RefObject<HTMLElement | null>,
  onOutsideClick: () => void,
  isActive: boolean = true,
  useCapture: boolean = false,
): void => {
  useEffect(() => {
    if (!isActive) return;

    const handleClickOutside = (event: MouseEvent) => {
      // If the click is outside the referenced element
      if (ref.current && !ref.current.contains(event.target as Node)) {
        // For dropdowns and other UI elements that should close on outside click,
        // we prevent the default action and stop propagation to avoid conflicts
        if (useCapture) {
          event.stopPropagation();
        }

        // Call the provided callback
        onOutsideClick();
      }
    };

    // Add with a slight delay to prevent immediate triggering
    const timerId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, useCapture);
    }, 10);

    // Cleanup
    return () => {
      clearTimeout(timerId);
      document.removeEventListener('mousedown', handleClickOutside, useCapture);
    };
  }, [ref, onOutsideClick, isActive, useCapture]);
};

export default useEnhancedOutsideClick;
