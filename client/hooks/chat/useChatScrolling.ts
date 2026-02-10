import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { scrollToBottom } from '@/lib/utils/app/scrolling';

import { UI_CONSTANTS } from '@/lib/constants/ui';

interface UseChatScrollingProps {
  selectedConversationId?: string;
  messageCount: number;
  isStreaming: boolean;
  streamingContent?: string;
}

/**
 * Custom hook to manage all chat scrolling behavior
 * Handles auto-scroll, manual scroll detection, scroll button, and refs
 */
export function useChatScrolling({
  selectedConversationId,
  messageCount,
  isStreaming,
  streamingContent,
}: UseChatScrollingProps) {
  // Scroll-related state
  const [showScrollDownButton, setShowScrollDownButton] = useState(false);

  // DOM refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollPositionBeforeStreamEndRef = useRef<number>(0);

  // Tracking refs
  const previousMessageCountRef = useRef<number>(0);
  const wasStreamingRef = useRef(false);
  const isInitialRenderRef = useRef(true);
  const shouldAutoScrollRef = useRef(true);
  const hasScrolledToContentRef = useRef(false);

  // Reset scroll state when conversation changes
  useEffect(() => {
    isInitialRenderRef.current = true;
    previousMessageCountRef.current = 0;
    wasStreamingRef.current = false;
  }, [selectedConversationId]);

  // Smooth scroll to bottom on new messages (NOT during or after streaming)
  useEffect(() => {
    const currentMessageCount = messageCount;
    const previousCount = previousMessageCountRef.current;

    const streamingJustCompleted =
      wasStreamingRef.current === true && !isStreaming;

    // Only scroll to bottom for new messages when:
    // 1. Message count increased (new message added)
    // 2. Not currently streaming
    // 3. Streaming didn't just complete (let it stay where it is)
    // 4. Should auto scroll (user hasn't manually scrolled away)
    if (
      currentMessageCount > previousCount &&
      !isStreaming &&
      !streamingJustCompleted &&
      shouldAutoScrollRef.current &&
      chatContainerRef.current
    ) {
      setTimeout(() => {
        if (chatContainerRef.current) {
          chatContainerRef.current.scrollTo({
            top: chatContainerRef.current.scrollHeight,
            behavior: 'smooth',
          });
        }
      }, 0);
    }

    previousMessageCountRef.current = currentMessageCount;
    wasStreamingRef.current = isStreaming;
    isInitialRenderRef.current = false;
  }, [messageCount, isStreaming]);

  // When streaming starts, scroll to bottom and enable auto-scroll
  useEffect(() => {
    if (isStreaming) {
      shouldAutoScrollRef.current = true;
      hasScrolledToContentRef.current = false;

      // Immediately scroll to bottom when streaming starts
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTo({
          top: chatContainerRef.current.scrollHeight,
          behavior: 'instant',
        });
      }
    }
  }, [isStreaming]);

  // Scroll immediately when streaming content first appears (one time only)
  useEffect(() => {
    if (
      isStreaming &&
      streamingContent &&
      !hasScrolledToContentRef.current &&
      shouldAutoScrollRef.current &&
      chatContainerRef.current
    ) {
      hasScrolledToContentRef.current = true;
      chatContainerRef.current.scrollTo({
        top: chatContainerRef.current.scrollHeight,
        behavior: 'instant',
      });
    }
  }, [isStreaming, streamingContent]);

  // Detect manual scroll during streaming
  useEffect(() => {
    const handleScrollDuringStream = () => {
      if (isStreaming && chatContainerRef.current) {
        const container = chatContainerRef.current;
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight;

        if (distanceFromBottom > UI_CONSTANTS.SCROLL.AUTO_SCROLL_THRESHOLD) {
          shouldAutoScrollRef.current = false;
          setShowScrollDownButton(true);
        }
      }
    };

    const container = chatContainerRef.current;
    if (container) {
      container.addEventListener('wheel', handleScrollDuringStream, {
        passive: true,
      });
      container.addEventListener('touchmove', handleScrollDuringStream, {
        passive: true,
      });
      return () => {
        container.removeEventListener('wheel', handleScrollDuringStream);
        container.removeEventListener('touchmove', handleScrollDuringStream);
      };
    }
  }, [isStreaming]);

  // Capture scroll position before streaming ends
  useEffect(() => {
    if (isStreaming && chatContainerRef.current) {
      // Continuously save scroll position during streaming
      const interval = setInterval(() => {
        if (chatContainerRef.current) {
          scrollPositionBeforeStreamEndRef.current =
            chatContainerRef.current.scrollTop;
        }
      }, 100);

      return () => clearInterval(interval);
    }
  }, [isStreaming]);

  // Smooth auto-scroll during streaming - stops when streaming ends
  useEffect(() => {
    if (!isStreaming || !shouldAutoScrollRef.current) {
      return;
    }

    let animationFrameId: number;
    let lastScrollHeight = 0;

    const smoothScroll = () => {
      const container = chatContainerRef.current;
      if (!container || !shouldAutoScrollRef.current || !isStreaming) return;

      const targetScroll = container.scrollHeight - container.clientHeight;
      const currentScroll = container.scrollTop;

      // Only scroll if content actually grew
      if (container.scrollHeight > lastScrollHeight) {
        lastScrollHeight = container.scrollHeight;
        const diff = targetScroll - currentScroll;

        if (Math.abs(diff) > 0.5) {
          container.scrollTop = currentScroll + diff * 0.2;
        } else {
          container.scrollTop = targetScroll;
        }
      }

      animationFrameId = requestAnimationFrame(smoothScroll);
    };

    animationFrameId = requestAnimationFrame(smoothScroll);

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [isStreaming]);

  // Restore scroll position after streaming ends - use layoutEffect to prevent flash
  useLayoutEffect(() => {
    if (isStreaming) return;

    const container = chatContainerRef.current;
    if (!container) return;

    if (shouldAutoScrollRef.current) {
      // User was following along — scroll to the very bottom
      container.scrollTop = container.scrollHeight;
    } else if (scrollPositionBeforeStreamEndRef.current > 0) {
      // User scrolled away — restore their position
      container.scrollTop = scrollPositionBeforeStreamEndRef.current;
    }
  }, [isStreaming, messageCount, streamingContent]);

  // Additional restore after paint to catch any async updates
  useEffect(() => {
    if (isStreaming) return;

    const container = chatContainerRef.current;
    if (!container) return;

    // Double-check scroll position after paint
    requestAnimationFrame(() => {
      if (!container) return;

      if (shouldAutoScrollRef.current) {
        // User was following along — ensure we're at the bottom
        container.scrollTop = container.scrollHeight;
      } else if (
        scrollPositionBeforeStreamEndRef.current > 0 &&
        container.scrollTop === 0
      ) {
        container.scrollTop = scrollPositionBeforeStreamEndRef.current;
      }
    });
  }, [isStreaming, messageCount]);

  // Handle scroll detection for scroll-down button
  useEffect(() => {
    const handleScroll = () => {
      const container = chatContainerRef.current;
      if (!container) return;

      const isAtBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        100;

      const hasContent = messageCount > 0 || !!streamingContent;
      setShowScrollDownButton(!isAtBottom && hasContent);
    };

    const container = chatContainerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [messageCount, streamingContent]);

  const handleScrollDown = () => {
    scrollToBottom(messagesEndRef, 'smooth');
  };

  return {
    // Refs for DOM
    messagesEndRef,
    chatContainerRef,
    lastMessageRef,
    // State
    showScrollDownButton,
    // Handlers
    handleScrollDown,
  };
}
