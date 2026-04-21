import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { scrollToBottom } from '@/lib/utils/app/scrolling';

import { UI_CONSTANTS } from '@/lib/constants/ui';

type ScrollPhase = 'idle' | 'streaming' | 'completing';

interface UseChatScrollingProps {
  selectedConversationId?: string;
  messageCount: number;
  isStreaming: boolean;
  streamingContent?: string;
  isDraining?: boolean;
}

/**
 * State-machine-based chat scrolling hook.
 *
 * Phase transitions: idle → streaming → completing → idle
 *
 * The phaseRef acts as a synchronous kill switch — RAF callbacks check it
 * before touching scrollTop, eliminating ghost-frame races.
 */
export function useChatScrolling({
  selectedConversationId,
  messageCount,
  isStreaming,
  streamingContent,
  isDraining = false,
}: UseChatScrollingProps) {
  const isActive = isStreaming || isDraining;

  const [showScrollDownButton, setShowScrollDownButton] = useState(false);

  // DOM refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const bottomSpacerRef = useRef<HTMLDivElement>(null);

  // State machine refs
  const phaseRef = useRef<ScrollPhase>('idle');
  const shouldAutoScrollRef = useRef(true);
  const rafIdRef = useRef(0);
  const prevMessageCountRef = useRef(0);

  // Effect 1 — Reset on conversation change
  useEffect(() => {
    phaseRef.current = 'idle';
    shouldAutoScrollRef.current = true;
    prevMessageCountRef.current = 0;
  }, [selectedConversationId]);

  // Effect 2 — Phase transitions (useLayoutEffect for synchronous phase updates)
  useLayoutEffect(() => {
    if (isActive && phaseRef.current === 'idle') {
      // idle → streaming
      phaseRef.current = 'streaming';
      shouldAutoScrollRef.current = true;

      if (bottomSpacerRef.current) {
        bottomSpacerRef.current.style.height = '0px';
      }

      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTo({
          top: chatContainerRef.current.scrollHeight,
          behavior: 'instant',
        });
      }
    } else if (!isActive && phaseRef.current === 'streaming') {
      // streaming → completing → idle
      phaseRef.current = 'completing';

      const container = chatContainerRef.current;
      const lastMsg = lastMessageRef.current;

      if (shouldAutoScrollRef.current && container) {
        if (lastMsg) {
          const containerRect = container.getBoundingClientRect();
          const msgRect = lastMsg.getBoundingClientRect();
          const relativeTop =
            msgRect.top - containerRect.top + container.scrollTop;
          const contextMargin = 60;

          const desiredScroll = Math.max(0, relativeTop - contextMargin);
          const maxScroll = container.scrollHeight - container.clientHeight;
          if (desiredScroll > maxScroll && bottomSpacerRef.current) {
            bottomSpacerRef.current.style.height = `${desiredScroll - maxScroll}px`;
          }
          container.scrollTo({
            top: desiredScroll,
            behavior: 'instant',
          });
        } else {
          container.scrollTop = container.scrollHeight;
        }
      }

      phaseRef.current = 'idle';
    }
  }, [isActive]);

  // Effect 3 — RAF loop + manual scroll detection during streaming
  useEffect(() => {
    if (!isActive) return;

    const container = chatContainerRef.current;
    if (!container) return;

    // RAF loop: snap to bottom each frame while streaming, unless the user
    // has taken control. The loop keeps rearming through the whole streaming
    // phase so auto-scroll can resume when the user returns to the bottom.
    const tick = () => {
      if (phaseRef.current !== 'streaming') return;
      const c = chatContainerRef.current;
      if (c && shouldAutoScrollRef.current) {
        c.scrollTop = c.scrollHeight - c.clientHeight;
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);

    // Any user-initiated interaction = intent to take control. We can't
    // consult `scrollTop` here because `wheel` / `touchmove` fire before the
    // browser applies the scroll — at this moment scrollTop is still the
    // bottom that RAF just snapped it to, so a position-based check reports
    // "at bottom" and the next RAF tick undoes the user's scroll. Trust the
    // interaction itself instead.
    const pauseAutoScroll = () => {
      if (shouldAutoScrollRef.current) {
        shouldAutoScrollRef.current = false;
        setShowScrollDownButton(true);
      }
    };

    // Resume auto-scroll when the user has scrolled back near the bottom.
    // Gated on `shouldAutoScrollRef.current === false` so the scroll events
    // RAF produces on its own writes don't create a feedback loop that
    // instantly re-enables the pin the user just disabled.
    const resumeIfAtBottom = () => {
      if (shouldAutoScrollRef.current) return;
      const c = chatContainerRef.current;
      if (!c) return;
      const distanceFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (distanceFromBottom < UI_CONSTANTS.SCROLL.BOTTOM_THRESHOLD) {
        shouldAutoScrollRef.current = true;
        setShowScrollDownButton(false);
      }
    };

    container.addEventListener('wheel', pauseAutoScroll, { passive: true });
    container.addEventListener('touchmove', pauseAutoScroll, { passive: true });
    container.addEventListener('scroll', resumeIfAtBottom, { passive: true });

    return () => {
      cancelAnimationFrame(rafIdRef.current);
      container.removeEventListener('wheel', pauseAutoScroll);
      container.removeEventListener('touchmove', pauseAutoScroll);
      container.removeEventListener('scroll', resumeIfAtBottom);
    };
  }, [isActive]);

  // Effect 4 — Scroll button visibility + idle new-message scroll
  useEffect(() => {
    const container = chatContainerRef.current;

    // Scroll button visibility
    const handleScroll = () => {
      if (!container) return;
      const isAtBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        100;
      const hasContent = messageCount > 0 || !!streamingContent;
      setShowScrollDownButton(!isAtBottom && hasContent);

      // Progressively shrink spacer so user can't scroll into whitespace
      const spacer = bottomSpacerRef.current;
      if (spacer && phaseRef.current === 'idle') {
        const spacerHeight = spacer.offsetHeight;
        if (spacerHeight > 0) {
          const realContentHeight = container.scrollHeight - spacerHeight;
          const maxRealScroll = realContentHeight - container.clientHeight;
          const neededSpacer = Math.max(0, container.scrollTop - maxRealScroll);
          if (neededSpacer < spacerHeight) {
            spacer.style.height = `${neededSpacer}px`;
          }
        }
      }
    };

    if (container) {
      container.addEventListener('scroll', handleScroll);
    }

    // Idle new-message scroll
    if (
      phaseRef.current === 'idle' &&
      messageCount > prevMessageCountRef.current &&
      shouldAutoScrollRef.current &&
      container
    ) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      });
    }

    prevMessageCountRef.current = messageCount;

    return () => {
      if (container) {
        container.removeEventListener('scroll', handleScroll);
      }
    };
  }, [messageCount, streamingContent]);

  const handleScrollDown = () => {
    shouldAutoScrollRef.current = true;
    scrollToBottom(messagesEndRef, 'smooth');
  };

  return {
    messagesEndRef,
    chatContainerRef,
    lastMessageRef,
    bottomSpacerRef,
    showScrollDownButton,
    handleScrollDown,
  };
}
