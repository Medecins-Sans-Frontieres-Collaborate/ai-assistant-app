import { act, renderHook } from '@testing-library/react';

import { useChatScrolling } from '@/client/hooks/chat/useChatScrolling';

import { scrollToBottom } from '@/lib/utils/app/scrolling';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/app/scrolling');

vi.mock('@/lib/constants/ui', () => ({
  UI_CONSTANTS: {
    SCROLL: {
      AUTO_SCROLL_THRESHOLD: 200,
      BOTTOM_THRESHOLD: 100,
    },
  },
}));

function createMockContainer(overrides: Record<string, unknown> = {}) {
  return {
    scrollTo: vi.fn(),
    scrollHeight: 2000,
    scrollTop: 1500,
    clientHeight: 500,
    getBoundingClientRect: vi.fn().mockReturnValue({ top: 0 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  };
}

function createMockLastMessage(top = 400) {
  return {
    getBoundingClientRect: vi.fn().mockReturnValue({ top }),
  };
}

describe('useChatScrolling', () => {
  let rafCallbacks: Array<() => void>;
  let originalRAF: typeof requestAnimationFrame;
  let originalCancelRAF: typeof cancelAnimationFrame;

  beforeEach(() => {
    vi.clearAllMocks();
    rafCallbacks = [];
    originalRAF = globalThis.requestAnimationFrame;
    originalCancelRAF = globalThis.cancelAnimationFrame;

    let rafId = 0;
    globalThis.requestAnimationFrame = vi.fn((cb: (time: number) => void) => {
      rafId += 1;
      rafCallbacks.push(cb as () => void);
      return rafId;
    });
    globalThis.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCancelRAF;
  });

  describe('initial state', () => {
    it('should initialize with scroll button hidden and refs created', () => {
      const { result } = renderHook(() =>
        useChatScrolling({
          selectedConversationId: 'conv-1',
          messageCount: 0,
          isStreaming: false,
          isDraining: false,
        }),
      );

      expect(result.current.showScrollDownButton).toBe(false);
      expect(result.current.messagesEndRef).toBeDefined();
      expect(result.current.chatContainerRef).toBeDefined();
      expect(result.current.lastMessageRef).toBeDefined();
    });
  });

  describe('conversation reset', () => {
    it('should reset phase to idle on conversation change', () => {
      const mockContainer = createMockContainer();

      const { result, rerender } = renderHook(
        ({ conversationId, messageCount }) =>
          useChatScrolling({
            selectedConversationId: conversationId,
            messageCount,
            isStreaming: false,
            isDraining: false,
          }),
        { initialProps: { conversationId: 'conv-1', messageCount: 5 } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;

      // Change conversation — should reset, then a new message should trigger smooth scroll
      rerender({ conversationId: 'conv-2', messageCount: 0 });
      rerender({ conversationId: 'conv-2', messageCount: 1 });

      expect(mockContainer.scrollTo).toHaveBeenCalledWith({
        top: mockContainer.scrollHeight,
        behavior: 'smooth',
      });
    });
  });

  describe('idle → streaming transition', () => {
    it('should scroll to bottom instantly when streaming starts', () => {
      const mockContainer = createMockContainer({ scrollTop: 0 });

      const { result, rerender } = renderHook(
        ({ isStreaming }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount: 1,
            isStreaming,
            isDraining: false,
          }),
        { initialProps: { isStreaming: false } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;

      rerender({ isStreaming: true });

      expect(mockContainer.scrollTo).toHaveBeenCalledWith({
        top: mockContainer.scrollHeight,
        behavior: 'instant',
      });
    });
  });

  describe('streaming → completing transition', () => {
    it('should scroll to top of last message after streaming completes', () => {
      const mockContainer = createMockContainer({ scrollTop: 1500 });
      const mockLastMsg = createMockLastMessage(400);

      const { result, rerender } = renderHook(
        ({ isStreaming, messageCount }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount,
            isStreaming,
            isDraining: false,
          }),
        { initialProps: { isStreaming: false, messageCount: 1 } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;
      (result.current.lastMessageRef as any).current = mockLastMsg;

      // Start streaming
      rerender({ isStreaming: true, messageCount: 1 });
      mockContainer.scrollTo.mockClear();

      // Stop streaming
      rerender({ isStreaming: false, messageCount: 2 });

      // relativeTop = msgRect.top(400) - containerRect.top(0) + scrollTop(1500) = 1900
      // scrollTarget = 1900 - 60 = 1840
      expect(mockContainer.scrollTo).toHaveBeenCalledWith({
        top: 1840,
        behavior: 'instant',
      });
    });

    it('should fall back to scrollHeight when lastMessageRef is not set', () => {
      const mockContainer = createMockContainer();

      const { result, rerender } = renderHook(
        ({ isStreaming }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount: 1,
            isStreaming,
            isDraining: false,
          }),
        { initialProps: { isStreaming: false } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;
      // lastMessageRef intentionally left null

      rerender({ isStreaming: true });
      rerender({ isStreaming: false });

      expect(mockContainer.scrollTop).toBe(mockContainer.scrollHeight);
    });
  });

  describe('user scrolled away during streaming', () => {
    it('should skip completion scroll when user has scrolled away', () => {
      const mockContainer = createMockContainer();
      const mockLastMsg = createMockLastMessage(400);

      const { result, rerender } = renderHook(
        ({ isStreaming }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount: 1,
            isStreaming,
            isDraining: false,
          }),
        { initialProps: { isStreaming: false } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;
      (result.current.lastMessageRef as any).current = mockLastMsg;

      // Start streaming
      rerender({ isStreaming: true });
      mockContainer.scrollTo.mockClear();

      // Simulate user scrolling away via wheel event
      const wheelHandler = mockContainer.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'wheel',
      )?.[1];

      if (wheelHandler) {
        // Set container to be far from bottom
        mockContainer.scrollTop = 0;
        act(() => {
          wheelHandler();
        });
      }

      // Stop streaming
      rerender({ isStreaming: false });

      // Completion scroll should NOT have been called
      expect(mockContainer.scrollTo).not.toHaveBeenCalled();
    });

    it('pauses auto-scroll on wheel even when scrollTop still reads as bottom (stale-read race)', () => {
      // Regression test for the bug where `wheel` fires before the browser
      // applies the user's scroll, so reading scrollTop in the wheel handler
      // saw the bottom position RAF had just snapped to, and the handler
      // failed to pause — letting the next RAF frame undo the user's scroll.
      const scrollHeight = 2000;
      const clientHeight = 500;
      const mockContainer = createMockContainer({
        scrollHeight,
        clientHeight,
        // Container is still reporting "at bottom" at the moment the wheel
        // handler fires, because the browser hasn't applied the scroll yet.
        scrollTop: scrollHeight - clientHeight,
      });

      const { result, rerender } = renderHook(
        ({ isStreaming }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount: 1,
            isStreaming,
            isDraining: false,
          }),
        { initialProps: { isStreaming: false } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;
      rerender({ isStreaming: true });

      const wheelHandler = mockContainer.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'wheel',
      )?.[1];
      expect(wheelHandler).toBeDefined();

      act(() => {
        wheelHandler!();
      });
      expect(result.current.showScrollDownButton).toBe(true);

      // Now simulate the browser applying the user's wheel scroll, and a RAF
      // tick that should NOT re-snap to bottom because pause already happened.
      mockContainer.scrollTop = 1200; // user scrolled up 300px
      act(() => {
        rafCallbacks.forEach((cb) => cb());
      });
      // scrollTop must stay where the user scrolled to — not get snapped back.
      expect(mockContainer.scrollTop).toBe(1200);
    });

    it('resumes auto-scroll when user scrolls back near the bottom', () => {
      const scrollHeight = 2000;
      const clientHeight = 500;
      const mockContainer = createMockContainer({
        scrollHeight,
        clientHeight,
        scrollTop: scrollHeight - clientHeight,
      });

      const { result, rerender } = renderHook(
        ({ isStreaming }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount: 1,
            isStreaming,
            isDraining: false,
          }),
        { initialProps: { isStreaming: false } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;
      rerender({ isStreaming: true });

      const wheelHandler = mockContainer.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'wheel',
      )?.[1];
      const scrollHandler = mockContainer.addEventListener.mock.calls.find(
        (call: any) => call[0] === 'scroll',
      )?.[1];
      expect(scrollHandler).toBeDefined();

      // Pause.
      act(() => {
        wheelHandler!();
      });
      expect(result.current.showScrollDownButton).toBe(true);

      // User scrolls back to within BOTTOM_THRESHOLD of the bottom.
      mockContainer.scrollTop = scrollHeight - clientHeight - 50;
      act(() => {
        scrollHandler!();
      });
      expect(result.current.showScrollDownButton).toBe(false);

      // Next RAF tick should resume snapping to bottom.
      act(() => {
        rafCallbacks.forEach((cb) => cb());
      });
      expect(mockContainer.scrollTop).toBe(scrollHeight - clientHeight);
    });
  });

  describe('ghost RAF after completion', () => {
    it('should not overwrite scrollTop when phase is no longer streaming', () => {
      const mockContainer = createMockContainer({ scrollTop: 500 });

      const { result, rerender } = renderHook(
        ({ isStreaming }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount: 1,
            isStreaming,
            isDraining: false,
          }),
        { initialProps: { isStreaming: false } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;

      // Start streaming — this schedules RAF callbacks
      rerender({ isStreaming: true });

      // Capture the RAF callback that was scheduled
      const capturedCallbacks = [...rafCallbacks];
      rafCallbacks = [];

      // Stop streaming — phase transitions to completing then idle
      rerender({ isStreaming: false });

      // Now fire the captured ghost RAF callback
      const scrollTopBefore = mockContainer.scrollTop;
      capturedCallbacks.forEach((cb) => cb());

      // scrollTop should NOT have been changed to scrollHeight - clientHeight
      // because the phase guard prevents it
      expect(mockContainer.scrollTop).toBe(scrollTopBefore);
    });
  });

  describe('new message in idle', () => {
    it('should smooth scroll to bottom for new messages when idle', () => {
      const mockContainer = createMockContainer();

      const { result, rerender } = renderHook(
        ({ messageCount }) =>
          useChatScrolling({
            selectedConversationId: 'conv-1',
            messageCount,
            isStreaming: false,
            isDraining: false,
          }),
        { initialProps: { messageCount: 1 } },
      );

      (result.current.chatContainerRef as any).current = mockContainer;

      rerender({ messageCount: 2 });

      expect(mockContainer.scrollTo).toHaveBeenCalledWith({
        top: mockContainer.scrollHeight,
        behavior: 'smooth',
      });
    });
  });

  describe('handleScrollDown', () => {
    it('should call scrollToBottom with smooth behavior', () => {
      const { result } = renderHook(() =>
        useChatScrolling({
          selectedConversationId: 'conv-1',
          messageCount: 5,
          isStreaming: false,
          isDraining: false,
        }),
      );

      act(() => {
        result.current.handleScrollDown();
      });

      expect(scrollToBottom).toHaveBeenCalledWith(
        result.current.messagesEndRef,
        'smooth',
      );
    });
  });
});
