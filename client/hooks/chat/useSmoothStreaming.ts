import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface SmoothStreamingOptions {
  isStreaming: boolean; // Whether the actual data is streaming
  content: string; // The full content to display
  charsPerFrame?: number; // How many characters to add per animation frame
  frameDelay?: number; // Milliseconds between frames
  enabled?: boolean; // Whether smooth streaming is enabled
}

interface SmoothStreamingResult {
  content: string;
  isDraining: boolean;
}

/**
 * Custom hook to provide a smooth text streaming animation between actual content chunks.
 * Includes a "drain" phase: when streaming ends before animation catches up,
 * remaining text is animated at 2x speed instead of appearing instantly.
 */
export const useSmoothStreaming = ({
  isStreaming,
  content,
  charsPerFrame = 6,
  frameDelay = 10,
  enabled = true,
}: SmoothStreamingOptions): SmoothStreamingResult => {
  const [displayedContent, setDisplayedContent] = useState<string>('');
  const [isDraining, setIsDraining] = useState(false);
  const contentRef = useRef<string>('');
  const animationFrameRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number>(0);
  const charsPerFrameRef = useRef(charsPerFrame);
  const frameDelayRef = useRef(frameDelay);
  const needsResetRef = useRef(false);

  // Drain-related refs
  const prevIsStreamingRef = useRef(isStreaming);
  const lastStreamingContentRef = useRef<string>('');
  const drainTargetRef = useRef<string>('');
  const isDrainingRef = useRef(false);
  const displayedLengthRef = useRef(0);
  const drainTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track displayed length for drain detection without reading state
  useEffect(() => {
    displayedLengthRef.current = displayedContent.length;
  }, [displayedContent]);

  // Track content during streaming for drain target
  useEffect(() => {
    if (isStreaming && content) {
      lastStreamingContentRef.current = content;
    }
  }, [isStreaming, content]);

  // Detect streaming transitions (useLayoutEffect runs before paint)
  // setState calls are wrapped in queueMicrotask to satisfy lint rules.
  // The one-frame gap this creates (where both enabled and isDraining are
  // false) is handled in the return logic by falling back to displayedContent.
  useLayoutEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    if (isStreaming && !wasStreaming) {
      // Streaming just started: reset animation state
      needsResetRef.current = true;
      contentRef.current = '';
      displayedLengthRef.current = 0;
      // Clear stale displayed content before paint
      queueMicrotask(() => {
        setDisplayedContent('');
      });
    }

    if (!isStreaming && wasStreaming) {
      // Streaming just ended: check if drain is needed
      const target = lastStreamingContentRef.current;
      const currentLength = displayedLengthRef.current;

      if (currentLength < target.length) {
        // Animation hasn't caught up — enter drain phase
        drainTargetRef.current = target;
        isDrainingRef.current = true;
        queueMicrotask(() => {
          setIsDraining(true);
        });

        // Safety timeout: force-fill after 2 seconds
        drainTimeoutRef.current = setTimeout(() => {
          setDisplayedContent(drainTargetRef.current);
          displayedLengthRef.current = drainTargetRef.current.length;
          isDrainingRef.current = false;
          setIsDraining(false);
        }, 2000);
      }
    }

    return () => {
      if (drainTimeoutRef.current) {
        clearTimeout(drainTimeoutRef.current);
        drainTimeoutRef.current = null;
      }
    };
  }, [isStreaming]);

  // Update refs when props change
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    charsPerFrameRef.current = charsPerFrame;
    frameDelayRef.current = frameDelay;
  }, [charsPerFrame, frameDelay]);

  // Single animation loop - runs once on mount, continues until unmount
  useEffect(() => {
    const animateText = (timestamp: number) => {
      // Only update based on frameDelay
      if (timestamp - lastTimestampRef.current < frameDelayRef.current) {
        animationFrameRef.current = requestAnimationFrame(animateText);
        return;
      }

      lastTimestampRef.current = timestamp;

      setDisplayedContent((prev) => {
        // Handle reset for new streaming session
        if (needsResetRef.current) {
          needsResetRef.current = false;
          displayedLengthRef.current = 0;
          animationFrameRef.current = requestAnimationFrame(animateText);
          return '';
        }

        // Determine target content and speed based on drain state
        const isDrain = isDrainingRef.current;
        const target = isDrain ? drainTargetRef.current : contentRef.current;
        const speed = isDrain
          ? charsPerFrameRef.current * 2
          : charsPerFrameRef.current;

        // If caught up, check if drain is done
        if (prev.length >= target.length) {
          if (isDrain) {
            isDrainingRef.current = false;
            // Clear safety timeout
            if (drainTimeoutRef.current) {
              clearTimeout(drainTimeoutRef.current);
              drainTimeoutRef.current = null;
            }
            // End drain state (setState in RAF callback is lint-safe)
            setIsDraining(false);
          }
          animationFrameRef.current = requestAnimationFrame(animateText);
          return prev;
        }

        // Calculate how many characters to add
        const nextCharsCount = Math.min(speed, target.length - prev.length);

        const next =
          prev + target.slice(prev.length, prev.length + nextCharsCount);
        displayedLengthRef.current = next.length;

        // Add characters and continue animation
        animationFrameRef.current = requestAnimationFrame(animateText);
        return next;
      });
    };

    // Start the single continuous animation loop
    animationFrameRef.current = requestAnimationFrame(animateText);

    // Only clean up on unmount
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (drainTimeoutRef.current) {
        clearTimeout(drainTimeoutRef.current);
        drainTimeoutRef.current = null;
      }
    };
  }, []); // Empty deps - runs once on mount

  // Return logic: handle each state with appropriate content
  if (!enabled && !isDraining) {
    // isDrainingRef is set synchronously in useLayoutEffect while the
    // isDraining state updates via queueMicrotask. When the ref is true
    // but state is false, we're in the one-frame gap before drain kicks in.
    // Reading the ref during render is intentional — it's the only synchronous
    // signal available before the queued state update fires.
    // eslint-disable-next-line react-hooks/refs -- bridges sync ref / async state gap
    if (isDrainingRef.current && displayedContent) {
      return { content: displayedContent, isDraining: true };
    }
    return { content, isDraining: false };
  }

  if (isDraining) {
    return { content: displayedContent, isDraining: true };
  }

  return { content: displayedContent, isDraining: false };
};
