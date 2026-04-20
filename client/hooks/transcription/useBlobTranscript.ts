'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  BlobReference,
  getDaysUntilExpiry,
  parseBlobReference,
} from '@/lib/utils/shared/transcription/blobReference';

/** Polling interval in milliseconds. */
const POLL_INTERVAL_MS = 3000;

/** Maximum total attempts (≈20 min at 3s interval). */
const MAX_POLL_ATTEMPTS = 400;

/**
 * Cap retries specifically for 404s. Early 404s can mean the blob upload is
 * still in flight, but sustained 404s mean the blob is expired or was never
 * written — no point burning the full 20-minute budget.
 */
const MAX_NOT_FOUND_ATTEMPTS = 5;

export interface UseBlobTranscriptOptions {
  /** Localized "generic fetch failure" message. */
  fetchErrorMessage: string;
  /** Localized "blob expired or was never written" message. */
  expiredOrDeletedMessage: string;
}

export interface UseBlobTranscriptResult {
  /** Parsed blob reference, or null when the content is inline text. */
  blobRef: BlobReference | null;
  /** Loaded transcript content once polling succeeds; null while loading/failed. */
  loadedContent: string | null;
  /** User-facing error message, or null. */
  error: string | null;
  /** True while a blob reference is being polled. */
  isLoading: boolean;
  /** Visible poll attempt count for UI display. */
  pollCount: number;
  /** Days until expiry; null when content isn't a blob reference. */
  daysUntilExpiry: number | null;
  /** True when the blob's expiry timestamp is already in the past. */
  isExpired: boolean;
}

/**
 * Polls `/api/transcription/content/<jobId>` for the transcript associated
 * with a blob reference. Shared across `TranscriptContent` (message-body)
 * and `TranscriptViewer` (inline viewer).
 *
 * Inline content (non-blob-reference strings) short-circuits — the hook
 * returns `{ blobRef: null, … }` and does no network work.
 */
export function useBlobTranscript(
  content: string,
  options: UseBlobTranscriptOptions,
): UseBlobTranscriptResult {
  const { fetchErrorMessage, expiredOrDeletedMessage } = options;

  const [loadedContent, setLoadedContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [notFoundCount, setNotFoundCount] = useState(0);

  const isMountedRef = useRef(true);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const blobRef = useMemo(() => parseBlobReference(content), [content]);

  // Reset counters + cached content when the hook is reused for a different
  // blob reference. Without this, a component instance that sees a rapid
  // succession of blob refs inherits the previous jobId's 404/poll counts
  // and may prematurely declare the new blob "expired or deleted".
  //
  // Uses the render-time reset pattern (React docs: "You might not need an
  // effect → Resetting all state when a prop changes") so the reset is
  // observed on the same render, not one frame later as with useEffect.
  const prevJobIdRef = useRef<string | undefined>(blobRef?.jobId);
  if (prevJobIdRef.current !== blobRef?.jobId) {
    prevJobIdRef.current = blobRef?.jobId;
    setLoadedContent(null);
    setError(null);
    setPollCount(0);
    setNotFoundCount(0);
  }

  const daysUntilExpiry = blobRef
    ? getDaysUntilExpiry(blobRef.expiresAt)
    : null;
  const isExpired = daysUntilExpiry !== null && daysUntilExpiry <= 0;

  const shouldPoll =
    blobRef !== null &&
    !isExpired &&
    loadedContent === null &&
    error === null &&
    pollCount < MAX_POLL_ATTEMPTS;

  const fetchOnce = useCallback(async (): Promise<boolean> => {
    if (!blobRef) return true;

    try {
      const response = await fetch(
        `/api/transcription/content/${blobRef.jobId}`,
      );

      if (response.ok) {
        const responseBody = await response.json();
        const data = responseBody.data || responseBody;
        if (isMountedRef.current) {
          setLoadedContent(data.transcript);
        }
        return true; // Success — stop polling.
      }

      if (response.status === 404) {
        if (isMountedRef.current) {
          setNotFoundCount((c) => c + 1);
        }
        console.log(
          `[useBlobTranscript] Blob not found for job ${blobRef.jobId}, will retry`,
        );
        return false; // Retry (bounded by MAX_NOT_FOUND_ATTEMPTS below).
      }

      // Non-404 non-2xx: give up — this is not something polling will fix.
      if (isMountedRef.current) {
        setError(fetchErrorMessage);
      }
      return true;
    } catch (err) {
      console.error('[useBlobTranscript] Fetch error:', err);
      return false; // Network error — retry.
    }
  }, [blobRef, fetchErrorMessage]);

  useEffect(() => {
    if (!shouldPoll) return;

    isMountedRef.current = true;

    const poll = async () => {
      const success = await fetchOnce();

      // Sustained 404s — stop retrying with a specific message.
      if (!success && notFoundCount >= MAX_NOT_FOUND_ATTEMPTS) {
        if (isMountedRef.current) {
          setError(expiredOrDeletedMessage);
        }
        return;
      }

      if (!success && isMountedRef.current && pollCount < MAX_POLL_ATTEMPTS) {
        timeoutRef.current = setTimeout(() => {
          if (isMountedRef.current) {
            setPollCount((c) => c + 1);
          }
        }, POLL_INTERVAL_MS);
      } else if (!success && pollCount >= MAX_POLL_ATTEMPTS - 1) {
        if (isMountedRef.current) {
          setError(fetchErrorMessage);
        }
      }
    };

    poll();

    return () => {
      isMountedRef.current = false;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [
    shouldPoll,
    fetchOnce,
    pollCount,
    notFoundCount,
    fetchErrorMessage,
    expiredOrDeletedMessage,
  ]);

  return {
    blobRef,
    loadedContent,
    error,
    isLoading: shouldPoll && loadedContent === null,
    pollCount,
    daysUntilExpiry,
    isExpired,
  };
}
