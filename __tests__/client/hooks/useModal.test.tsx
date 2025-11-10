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
