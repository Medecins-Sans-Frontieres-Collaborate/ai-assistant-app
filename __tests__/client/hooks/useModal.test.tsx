import { act, renderHook } from '@testing-library/react';

import useModal from '@/client/hooks/ui/useModal';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('useModal', () => {
  let originalBodyOverflow: string;

  beforeEach(() => {
    vi.useFakeTimers();
    originalBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'visible';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.style.overflow = originalBodyOverflow;
  });

  describe('Modal Ref', () => {
    it('returns a ref object', () => {
      const onClose = vi.fn();
      const { result } = renderHook(() => useModal(false, onClose));

      expect(result.current).toHaveProperty('current');
      expect(result.current.current).toBeNull();
    });
  });

  describe('Outside Click Behavior', () => {
    it('calls onClose when clicking outside modal', () => {
      const onClose = vi.fn();
      const { result } = renderHook(() => useModal(true, onClose));

      const modalElement = document.createElement('div');
      result.current.current = modalElement;

      act(() => {
        vi.advanceTimersByTime(15);
      });

      const outsideClick = new MouseEvent('mousedown', { bubbles: true });
      act(() => {
        document.dispatchEvent(outsideClick);
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('respects preventOutsideClick option', () => {
      const onClose = vi.fn();
      const { result } = renderHook(() => useModal(true, onClose, true));

      const modalElement = document.createElement('div');
      result.current.current = modalElement;

      act(() => {
        vi.advanceTimersByTime(15);
      });

      const outsideClick = new MouseEvent('mousedown', { bubbles: true });
      act(() => {
        document.dispatchEvent(outsideClick);
      });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Escape Key Behavior', () => {
    it('calls onClose when Escape key is pressed', () => {
      const onClose = vi.fn();
      renderHook(() => useModal(true, onClose));

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      act(() => {
        document.dispatchEvent(escapeEvent);
      });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('respects preventEscapeKey option', () => {
      const onClose = vi.fn();
      renderHook(() => useModal(true, onClose, false, true));

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      act(() => {
        document.dispatchEvent(escapeEvent);
      });

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('Focus Trap', () => {
    let modalElement: HTMLDivElement;

    beforeEach(() => {
      modalElement = document.createElement('div');
      modalElement.innerHTML =
        '<button id="first">First</button><input id="middle" /><button id="last">Last</button>';
      document.body.appendChild(modalElement);
    });

    afterEach(() => {
      modalElement.remove();
    });

    const dispatchTab = (shiftKey = false) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.dispatchEvent(event);
      });
      return event;
    };

    it('wraps Tab from the last focusable element to the first', () => {
      const { result } = renderHook(() => useModal(true, vi.fn()));
      result.current.current = modalElement;

      (modalElement.querySelector('#last') as HTMLElement).focus();
      const event = dispatchTab();

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement?.id).toBe('first');
    });

    it('wraps Shift+Tab from the first focusable element to the last', () => {
      const { result } = renderHook(() => useModal(true, vi.fn()));
      result.current.current = modalElement;

      (modalElement.querySelector('#first') as HTMLElement).focus();
      const event = dispatchTab(true);

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement?.id).toBe('last');
    });

    it('does not intercept Tab between interior elements', () => {
      const { result } = renderHook(() => useModal(true, vi.fn()));
      result.current.current = modalElement;

      (modalElement.querySelector('#middle') as HTMLElement).focus();
      const event = dispatchTab();

      expect(event.defaultPrevented).toBe(false);
    });

    it('does not trap when focus is outside the modal', () => {
      const outsideButton = document.createElement('button');
      document.body.appendChild(outsideButton);

      const { result } = renderHook(() => useModal(true, vi.fn()));
      result.current.current = modalElement;

      outsideButton.focus();
      const event = dispatchTab();

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(outsideButton);

      outsideButton.remove();
    });

    it('keeps focus on the container when nothing inside is focusable', () => {
      const emptyModal = document.createElement('div');
      emptyModal.tabIndex = -1;
      document.body.appendChild(emptyModal);

      const { result } = renderHook(() => useModal(true, vi.fn()));
      result.current.current = emptyModal;

      emptyModal.focus();
      const event = dispatchTab();

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(emptyModal);

      emptyModal.remove();
    });
  });

  describe('Focus Restore', () => {
    it('restores focus to the previously focused element on close', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { rerender } = renderHook(({ open }) => useModal(open, vi.fn()), {
        initialProps: { open: true },
      });

      trigger.blur();
      rerender({ open: false });

      expect(document.activeElement).toBe(trigger);
      trigger.remove();
    });

    it('restores focus on unmount', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { unmount } = renderHook(() => useModal(true, vi.fn()));

      trigger.blur();
      unmount();

      expect(document.activeElement).toBe(trigger);
      trigger.remove();
    });

    it('does not throw when the previously focused element was removed', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      trigger.focus();

      const { unmount } = renderHook(() => useModal(true, vi.fn()));

      trigger.remove();

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Body Scroll Prevention', () => {
    it('sets body overflow to hidden when modal opens', () => {
      renderHook(() => useModal(true, vi.fn()));

      expect(document.body.style.overflow).toBe('hidden');
    });

    it('restores original body overflow on unmount', () => {
      document.body.style.overflow = 'scroll';

      const { unmount } = renderHook(() => useModal(true, vi.fn()));

      expect(document.body.style.overflow).toBe('hidden');

      unmount();

      expect(document.body.style.overflow).toBe('scroll');
    });
  });
});
