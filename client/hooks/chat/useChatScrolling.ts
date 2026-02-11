import { useEffect, useRef, useState } from 'react';

import { scrollToBottom } from '@/lib/utils/app/scrolling';

import { UI_CONSTANTS } from '@/lib/constants/ui';

interface UseChatScrollingProps {
  selectedConversationId?: string;
  messageCount: number;
  isStreaming: boolean;
  streamingContent?: string;
  isDraining?: boolean;
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
  isDraining = false,
}: UseChatScrollingProps) {
  // Content is still being produced (streaming or drain animation)
  const isActive = isStreaming || isDraining;

  // Scroll-related state
  const [showScrollDownButton, setShowScrollDownButton] = useState(false);

  // DOM refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollPositionBeforeStreamEndRef = useRef<number>(0);

  // Tracking refs
  const previousMessageCountRef = useRef<number>(0);
  const wasActiveRef = useRef(false);
  const isInitialRenderRef = useRef(true);
  const shouldAutoScrollRef = useRef(true);
  const hasScrolledToContentRef = useRef(false);

  // Reset scroll state when conversation changes
  useEffect(() => {
    isInitialRenderRef.current = true;
    previousMessageCountRef.current = 0;
    wasActiveRef.current = false;
  }, [selectedConversationId]);

  // Smooth scroll to bottom on new messages (NOT during or after streaming/drain)
  useEffect(() => {
    const currentMessageCount = messageCount;
    const previousCount = previousMessageCountRef.current;

    const activeJustCompleted = wasActiveRef.current === true && !isActive;

    // Only scroll to bottom for new messages when:
    // 1. Message count increased (new message added)
    // 2. Not currently active (streaming or draining)
    // 3. Active cycle didn't just complete (let it stay where it is)
    // 4. Should auto scroll (user hasn't manually scrolled away)
    if (
      currentMessageCount > previousCount &&
      !isActive &&
      !activeJustCompleted &&
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
    wasActiveRef.current = isActive;
    isInitialRenderRef.current = false;
  }, [messageCount, isActive]);

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
        // Follow-up scroll after DOM settles (catches loading indicator)
        requestAnimationFrame(() => {
          if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop =
              chatContainerRef.current.scrollHeight;
          }
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

  // Detect manual scroll during streaming or drain
  useEffect(() => {
    const handleScrollDuringStream = () => {
      if (isActive && chatContainerRef.current) {
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
  }, [isActive]);

  // Capture scroll position before streaming/drain ends
  useEffect(() => {
    if (isActive && chatContainerRef.current) {
      // Continuously save scroll position during streaming/drain
      const interval = setInterval(() => {
        if (chatContainerRef.current) {
          scrollPositionBeforeStreamEndRef.current =
            chatContainerRef.current.scrollTop;
        }
      }, 100);

      return () => clearInterval(interval);
    }
  }, [isActive]);

  // Smooth auto-scroll during streaming/drain - stops when both end
  useEffect(() => {
    if (!isActive || !shouldAutoScrollRef.current) {
      return;
    }

    let animationFrameId: number;
    let lastScrollHeight = 0;

    const smoothScroll = () => {
      const container = chatContainerRef.current;
      if (!container || !shouldAutoScrollRef.current || !isActive) return;

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
  }, [isActive]);

  // Restore scroll position after streaming/drain ends
  // Double-RAF ensures the DOM has fully settled after the
  // streaming-div → normal-message swap (action buttons appear, etc.)
  useEffect(() => {
    if (isActive) return;

    let cancelled = false;
    let outerRafId: number;
    let innerRafId: number;

    outerRafId = requestAnimationFrame(() => {
      innerRafId = requestAnimationFrame(() => {
        const container = chatContainerRef.current;
        if (cancelled || !container) return;

        if (shouldAutoScrollRef.current) {
          // User was following along — scroll to the very bottom
          container.scrollTop = container.scrollHeight;
        } else if (scrollPositionBeforeStreamEndRef.current > 0) {
          // User scrolled away — restore their position
          container.scrollTop = scrollPositionBeforeStreamEndRef.current;
        }
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(outerRafId);
      cancelAnimationFrame(innerRafId);
    };
  }, [isActive, messageCount]);

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
