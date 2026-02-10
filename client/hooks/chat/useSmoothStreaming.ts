import { useEffect, useRef, useState } from 'react';

interface SmoothStreamingOptions {
  isStreaming: boolean; // Whether the actual data is streaming
  content: string; // The full content to display
  charsPerFrame?: number; // How many characters to add per animation frame
  frameDelay?: number; // Milliseconds between frames
  enabled?: boolean; // Whether smooth streaming is enabled
}

/**
 * Custom hook to provide a smooth text streaming animation between actual content chunks
 *
 * @returns {string} The text to display with the smooth animation effect
 */
export const useSmoothStreaming = ({
  isStreaming,
  content,
  charsPerFrame = 6,
  frameDelay = 10,
  enabled = true,
}: SmoothStreamingOptions): string => {
  const [displayedContent, setDisplayedContent] = useState<string>('');
  const contentRef = useRef<string>('');
  const animationFrameRef = useRef<number | null>(null);
  const lastTimestampRef = useRef<number>(0);
  const charsPerFrameRef = useRef(charsPerFrame);
  const frameDelayRef = useRef(frameDelay);

  // Reset displayed content when a new streaming session starts
  useEffect(() => {
    if (isStreaming) {
      setDisplayedContent('');
      contentRef.current = '';
    }
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
        // If caught up, just return current content
        if (prev.length >= contentRef.current.length) {
          animationFrameRef.current = requestAnimationFrame(animateText);
          return prev;
        }

        // Calculate how many characters to add
        const nextCharsCount = Math.min(
          charsPerFrameRef.current,
          contentRef.current.length - prev.length,
        );

        // Add characters and continue animation
        animationFrameRef.current = requestAnimationFrame(animateText);
        return (
          prev +
          contentRef.current.slice(prev.length, prev.length + nextCharsCount)
        );
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
    };
  }, []); // Empty deps - runs once on mount

  // If smooth streaming is disabled, simply return the full content
  if (!enabled) {
    return content;
  }

  return displayedContent;
};
