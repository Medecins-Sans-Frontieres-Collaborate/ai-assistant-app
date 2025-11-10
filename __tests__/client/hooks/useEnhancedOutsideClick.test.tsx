import { renderHook } from '@testing-library/react';
import { useRef } from 'react';

import useEnhancedOutsideClick from '@/client/hooks/ui/useEnhancedOutsideClick';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('useEnhancedOutsideClick', () => {
  let targetElement: HTMLDivElement;
  let outsideElement: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();

    // Create DOM elements
    targetElement = document.createElement('div');
    targetElement.id = 'target';
    document.body.appendChild(targetElement);

    outsideElement = document.createElement('div');
    outsideElement.id = 'outside';
    document.body.appendChild(outsideElement);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.removeChild(targetElement);
    document.body.removeChild(outsideElement);
  });

  describe('Outside Click Detection', () => {
    it('calls callback when clicking outside element', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      // Advance timers to register the event listener
      vi.advanceTimersByTime(15);

      // Click outside
      const event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);

      expect(onOutsideClick).toHaveBeenCalledTimes(1);
    });

    it('does not call callback when clicking inside element', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);

      // Click inside
      const event = new MouseEvent('mousedown', { bubbles: true });
      targetElement.dispatchEvent(event);

      expect(onOutsideClick).not.toHaveBeenCalled();
    });

    it('detects clicks on child elements as inside', () => {
      const onOutsideClick = vi.fn();
      const childElement = document.createElement('span');
      targetElement.appendChild(childElement);

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);

      // Click on child
      const event = new MouseEvent('mousedown', { bubbles: true });
      childElement.dispatchEvent(event);

      expect(onOutsideClick).not.toHaveBeenCalled();
    });

    it('handles document clicks', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);

      // Click on document
      const event = new MouseEvent('mousedown', { bubbles: true });
      document.dispatchEvent(event);

      expect(onOutsideClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('isActive Flag', () => {
    it('does not call callback when isActive is false', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, false);
      });

      vi.advanceTimersByTime(15);

      // Click outside
      const event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);

      expect(onOutsideClick).not.toHaveBeenCalled();
    });

    it('can toggle active state', () => {
      const onOutsideClick = vi.fn();
      let isActive = false;

      const { rerender } = renderHook(
        ({ active }) => {
          const ref = useRef<HTMLElement>(targetElement);
          useEnhancedOutsideClick(ref, onOutsideClick, active);
        },
        { initialProps: { active: isActive } },
      );

      vi.advanceTimersByTime(15);

      // Click while inactive
      let event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);
      expect(onOutsideClick).not.toHaveBeenCalled();

      // Activate
      isActive = true;
      rerender({ active: isActive });
      vi.advanceTimersByTime(15);

      // Click while active
      event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);
      expect(onOutsideClick).toHaveBeenCalledTimes(1);
    });

    it('defaults to active when isActive not provided', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        // Not passing isActive, should default to true
        useEnhancedOutsideClick(ref, onOutsideClick);
      });

      vi.advanceTimersByTime(15);

      const event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);

      expect(onOutsideClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('useCapture Flag', () => {
    it('uses bubble phase by default', () => {
      const onOutsideClick = vi.fn();
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);

      // Check that addEventListener was called with useCapture = false
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'mousedown',
        expect.any(Function),
        false,
      );
    });

    it('uses capture phase when useCapture is true', () => {
      const onOutsideClick = vi.fn();
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true, true);
      });

      vi.advanceTimersByTime(15);

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'mousedown',
        expect.any(Function),
        true,
      );
    });

    it('stops propagation when useCapture is true and clicking outside', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true, true);
      });

      vi.advanceTimersByTime(15);

      const event = new MouseEvent('mousedown', { bubbles: true });
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

      outsideElement.dispatchEvent(event);

      expect(stopPropagationSpy).toHaveBeenCalled();
      expect(onOutsideClick).toHaveBeenCalled();
    });

    it('does not stop propagation when useCapture is false', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true, false);
      });

      vi.advanceTimersByTime(15);

      const event = new MouseEvent('mousedown', { bubbles: true });
      const stopPropagationSpy = vi.spyOn(event, 'stopPropagation');

      outsideElement.dispatchEvent(event);

      expect(stopPropagationSpy).not.toHaveBeenCalled();
      expect(onOutsideClick).toHaveBeenCalled();
    });
  });

  describe('Timeout Behavior', () => {
    it('delays event listener registration by 10ms', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      // Click immediately (before timeout)
      const event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);

      expect(onOutsideClick).not.toHaveBeenCalled();

      // Advance timers
      vi.advanceTimersByTime(10);

      // Click after timeout
      outsideElement.dispatchEvent(event);

      expect(onOutsideClick).toHaveBeenCalledTimes(1);
    });

    it('prevents immediate triggering on mount', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      // Simulate a click that happens during component mount
      const event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);

      // Should not be called yet
      expect(onOutsideClick).not.toHaveBeenCalled();

      // After timeout completes
      vi.advanceTimersByTime(15);
      outsideElement.dispatchEvent(event);

      // Now it should be called
      expect(onOutsideClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cleanup', () => {
    it('removes event listener on unmount', () => {
      const onOutsideClick = vi.fn();
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

      const { unmount } = renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'mousedown',
        expect.any(Function),
        false,
      );
    });

    it('clears timeout on unmount', () => {
      const onOutsideClick = vi.fn();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const { unmount } = renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      unmount();

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('does not trigger callback after unmount', () => {
      const onOutsideClick = vi.fn();

      const { unmount } = renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);
      unmount();

      // Click after unmount
      const event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);

      expect(onOutsideClick).not.toHaveBeenCalled();
    });
  });

  describe('Ref Changes', () => {
    it('handles null ref', () => {
      const onOutsideClick = vi.fn();

      renderHook(() => {
        const ref = useRef<HTMLElement>(null);
        useEnhancedOutsideClick(ref, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);

      const event = new MouseEvent('mousedown', { bubbles: true });

      expect(() => {
        document.dispatchEvent(event);
      }).not.toThrow();

      // With null ref, every click is "outside" (ref.current check fails)
      expect(onOutsideClick).not.toHaveBeenCalled();
    });

    it('handles ref with different elements', () => {
      const onOutsideClick = vi.fn();
      const element1 = targetElement;
      const element2 = document.createElement('div');
      document.body.appendChild(element2);

      const ref = { current: element1 };

      renderHook(() => {
        useEnhancedOutsideClick(ref as any, onOutsideClick, true);
      });

      vi.advanceTimersByTime(15);

      // Click on element2 (outside of element1)
      let event = new MouseEvent('mousedown', { bubbles: true });
      element2.dispatchEvent(event);
      expect(onOutsideClick).toHaveBeenCalledTimes(1);

      // Click on element1 (inside)
      event = new MouseEvent('mousedown', { bubbles: true });
      element1.dispatchEvent(event);
      expect(onOutsideClick).toHaveBeenCalledTimes(1); // Still 1

      document.body.removeChild(element2);
    });
  });

  describe('Callback Changes', () => {
    it('uses updated callback', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      let currentCallback = callback1;

      const { rerender } = renderHook(() => {
        const ref = useRef<HTMLElement>(targetElement);
        useEnhancedOutsideClick(ref, currentCallback, true);
      });

      vi.advanceTimersByTime(15);

      // Click with first callback
      let event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).not.toHaveBeenCalled();

      // Change callback
      currentCallback = callback2;
      rerender();
      vi.advanceTimersByTime(15);

      // Click with second callback
      event = new MouseEvent('mousedown', { bubbles: true });
      outsideElement.dispatchEvent(event);
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });
});
