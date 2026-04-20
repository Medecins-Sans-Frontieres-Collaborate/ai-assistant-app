/**
 * Hook for polling batch transcription job status.
 *
 * This hook automatically polls the transcription status endpoint for any
 * pending batch transcription jobs and updates the store when they complete.
 *
 * Handles two types of transcription jobs:
 * 1. Pre-submit jobs (from chatInputStore.pendingTranscriptions) - tracked before message is sent
 * 2. Post-submit jobs (from chatStore.pendingConversationTranscription) - for large files (>25MB)
 *    that are submitted and tracked after the message is already in the conversation
 *
 * Polling intervals increase over time:
 * - 0-10s: every 2 seconds
 * - 10-60s: every 5 seconds
 * - 1-5min: every 15 seconds
 * - 5min+: every 30 seconds
 */
import { useCallback, useEffect, useRef } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { generateConversationTitle } from '@/client/services/titleService';

import { ActiveFile } from '@/types/chat';
import {
  BatchTranscriptionStatusResponse,
  TRANSCRIPT_BLOB_THRESHOLD,
  TranscriptReference,
} from '@/types/transcription';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Picks localized copy and the right `react-hot-toast` variant for a failure
 * based on the server's classification. Keeping this in one place ensures the
 * toast string, the message-body string, and the file-preview state stay in
 * sync across cancellation, timeout, and the various error classes.
 */
type FailureCopy = {
  toastMessage: string;
  body: string;
  previewStatus: 'failed' | 'cancelled';
  /** True → `toast()`; false → `toast.error()`. */
  neutral: boolean;
};

function pickFailureCopy(
  data: Pick<
    BatchTranscriptionStatusResponse,
    'error' | 'errorClass' | 'cancelled'
  >,
  filename: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): FailureCopy {
  if (data.cancelled) {
    return {
      toastMessage: t('cancelledToast', { filename }),
      body: `[${t('cancelledBody')}]`,
      previewStatus: 'cancelled',
      neutral: true,
    };
  }
  switch (data.errorClass) {
    case 'rate_limit':
      return {
        toastMessage: t('rateLimitedToast', { filename }),
        body: `[${t('rateLimitedBody')}]`,
        previewStatus: 'failed',
        neutral: false,
      };
    case 'auth':
      return {
        toastMessage: t('authFailedToast', { filename }),
        body: `[${t('authFailedBody')}]`,
        previewStatus: 'failed',
        neutral: false,
      };
    case 'transient':
      return {
        toastMessage: t('transientToast', { filename }),
        body: `[${t('transientBody')}]`,
        previewStatus: 'failed',
        neutral: false,
      };
    case 'permanent':
      return {
        toastMessage: t('permanentToast', {
          filename,
          error: data.error ? ` — ${data.error}` : '',
        }),
        body: `[${t('failed', { error: data.error ?? t('unknownError') })}]`,
        previewStatus: 'failed',
        neutral: false,
      };
    default:
      return {
        toastMessage: t('failedToast', { filename }),
        body: `[${t('failed', { error: data.error ?? t('unknownError') })}]`,
        previewStatus: 'failed',
        neutral: false,
      };
  }
}

function showFailureToast(copy: FailureCopy): void {
  if (copy.neutral) {
    toast(copy.toastMessage, { duration: 5000 });
  } else {
    toast.error(copy.toastMessage, { duration: 5000 });
  }
}

/**
 * Stores a large transcript in blob storage and returns a reference.
 * Returns null if storage fails (caller should fall back to inline storage).
 */
async function storeTranscriptInBlob(
  jobId: string,
  transcript: string,
  filename: string,
  signal?: AbortSignal,
): Promise<TranscriptReference | null> {
  try {
    const response = await fetch('/api/transcription/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, transcript, filename }),
      signal,
    });

    if (!response.ok) {
      console.warn(
        `[useTranscriptionPolling] Failed to store transcript in blob: ${response.status}`,
      );
      return null;
    }

    const responseBody = await response.json();
    const data = responseBody.data || responseBody;
    return data as TranscriptReference;
  } catch (error) {
    if (isAbortError(error)) {
      return null;
    }
    console.warn(
      '[useTranscriptionPolling] Error storing transcript in blob:',
      error,
    );
    return null;
  }
}

/** Polling intervals in milliseconds */
const POLL_INTERVALS = {
  INITIAL: 2000, // 2 seconds
  SHORT: 5000, // 5 seconds
  MEDIUM: 15000, // 15 seconds
  LONG: 30000, // 30 seconds
} as const;

/** Time thresholds for interval changes (in milliseconds) */
const INTERVAL_THRESHOLDS = {
  SHORT: 10000, // 10 seconds
  MEDIUM: 60000, // 1 minute
  LONG: 300000, // 5 minutes
} as const;

/**
 * Determines the appropriate polling interval based on elapsed time.
 *
 * @param elapsedMs - Time elapsed since the job started
 * @returns The polling interval in milliseconds
 */
function getPollingInterval(elapsedMs: number): number {
  if (elapsedMs < INTERVAL_THRESHOLDS.SHORT) {
    return POLL_INTERVALS.INITIAL;
  }
  if (elapsedMs < INTERVAL_THRESHOLDS.MEDIUM) {
    return POLL_INTERVALS.SHORT;
  }
  if (elapsedMs < INTERVAL_THRESHOLDS.LONG) {
    return POLL_INTERVALS.MEDIUM;
  }
  return POLL_INTERVALS.LONG;
}

/**
 * Hook that polls for batch transcription job status.
 *
 * Call this hook in a component that needs to track transcription progress.
 * It will automatically start polling when there are pending jobs and stop
 * when all jobs are complete or failed.
 */
/** Base client-side timeout; scales up for chunked jobs with many chunks. */
export const BASE_TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min floor
export const PER_CHUNK_TIMEOUT_MS = 2 * 60 * 1000; // 2 min per chunk
export const MAX_TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 h ceiling

/**
 * Maximum consecutive polling failures before we give up and mark the job
 * as failed client-side. Raised from 5 to 15 so brief network blips don't
 * tear down jobs that are still running server-side — at the medium polling
 * cadence (5 s), 15 failures ≈ 75 s of connectivity loss.
 */
export const MAX_CONSECUTIVE_FAILURES = 15;

/**
 * Failure count at which the UI starts showing a subtle "Reconnecting…"
 * hint — well before the hard give-up at `MAX_CONSECUTIVE_FAILURES`. Keeps
 * users informed during transient blips without prematurely declaring
 * failure.
 */
export const RECONNECTING_THRESHOLD = 3;

/**
 * Computes the per-job client-side timeout. Exported so UI components (e.g.
 * `TranscriptionProgressIndicator`'s "may take up to N minutes" note) stay
 * in sync with the polling hook's abort window.
 */
export function computeTimeoutMs(totalChunks?: number): number {
  if (!totalChunks || totalChunks <= 1) {
    return BASE_TRANSCRIPTION_TIMEOUT_MS;
  }
  return Math.min(
    MAX_TRANSCRIPTION_TIMEOUT_MS,
    Math.max(BASE_TRANSCRIPTION_TIMEOUT_MS, totalChunks * PER_CHUNK_TIMEOUT_MS),
  );
}

export function useTranscriptionPolling(): void {
  const t = useTranslations('transcription');

  // Pre-submit transcription tracking (chatInputStore)
  const pendingTranscriptions = useChatInputStore(
    (state) => state.pendingTranscriptions,
  );
  const updateTranscriptionStatus = useChatInputStore(
    (state) => state.updateTranscriptionStatus,
  );
  const removePendingTranscription = useChatInputStore(
    (state) => state.removePendingTranscription,
  );
  const setTextFieldValue = useChatInputStore(
    (state) => state.setTextFieldValue,
  );
  const setFilePreviews = useChatInputStore((state) => state.setFilePreviews);

  // Post-submit transcription tracking (chatStore - for large files >25MB)
  const pendingConversationTranscription = useChatStore(
    (state) => state.pendingConversationTranscription,
  );
  const setConversationTranscriptionPending = useChatStore(
    (state) => state.setConversationTranscriptionPending,
  );
  const updateTranscriptionProgress = useChatStore(
    (state) => state.updateTranscriptionProgress,
  );
  const setTranscriptionReconnecting = useChatStore(
    (state) => state.setTranscriptionReconnecting,
  );

  // Conversation store for updating messages
  const updateMessageWithTranscript = useConversationStore(
    (state) => state.updateMessageWithTranscript,
  );
  const conversations = useConversationStore((state) => state.conversations);
  const updateConversation = useConversationStore(
    (state) => state.updateConversation,
  );

  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isPollingRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Lazily create the AbortController the first time we need it; keep the same
  // controller for the lifetime of the mounted hook and abort on unmount. All
  // in-flight fetches share it so unmount cancels every pending request.
  const getAbortSignal = useCallback((): AbortSignal => {
    if (!abortControllerRef.current) {
      abortControllerRef.current = new AbortController();
    }
    return abortControllerRef.current.signal;
  }, []);

  /**
   * Fire-and-forget request to release Azure resources for a finished job
   * (batch-service record + temp blob). Every failure/cancellation/timeout
   * path ends the same way, so this helper keeps those call sites aligned
   * and ensures we consistently attach the hook's abort signal.
   */
  const scheduleCleanup = useCallback(
    (payload: { jobId: string; blobPath?: string }) => {
      fetch('/api/transcription/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: getAbortSignal(),
      }).catch((err) => {
        if (!isAbortError(err)) console.warn(err);
      });
    },
    [getAbortSignal],
  );

  /**
   * Polls the status of a post-submit conversation transcription job.
   * These are for large files (>25MB) that were submitted and are tracked
   * after the message is already in the conversation.
   */
  const pollConversationTranscription = useCallback(async () => {
    if (!pendingConversationTranscription) return;

    const {
      jobId,
      filename,
      blobPath,
      startedAt,
      conversationId,
      messageIndex,
      totalChunks,
    } = pendingConversationTranscription;

    // Scale the client-side timeout by chunk count so long-but-healthy
    // chunked jobs don't get killed before the server finishes.
    const timeoutMs = computeTimeoutMs(totalChunks);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > timeoutMs) {
      const timeoutMinutes = Math.round(timeoutMs / 60000);
      console.warn(
        `[useTranscriptionPolling] Transcription timed out for ${filename} (${timeoutMinutes}m)`,
      );

      // Update message with timeout error
      updateMessageWithTranscript(
        conversationId,
        messageIndex,
        `[${t('timedOut', { minutes: timeoutMinutes })}]`,
        filename,
        jobId, // Pass jobId for reliable message matching
      );

      // Clear pending state
      setConversationTranscriptionPending(null);

      toast.error(t('timedOutToast', { filename }), {
        duration: 5000,
      });

      scheduleCleanup({ jobId, blobPath });

      return;
    }

    try {
      const response = await fetch(`/api/transcription/status/${jobId}`, {
        signal: getAbortSignal(),
      });

      if (!response.ok) {
        consecutiveFailuresRef.current++;
        console.error(
          `[useTranscriptionPolling] Failed to poll conversation job ${jobId}: ${response.status} ` +
            `(failure ${consecutiveFailuresRef.current}/${MAX_CONSECUTIVE_FAILURES})`,
        );

        if (consecutiveFailuresRef.current >= RECONNECTING_THRESHOLD) {
          setTranscriptionReconnecting(true);
        }

        // After N consecutive failures, assume the status channel is dead
        // and clear state. Treat as transient so the user sees "please try
        // again" rather than a generic permanent-failure message.
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          const copy = pickFailureCopy(
            { errorClass: 'transient' },
            filename,
            t,
          );
          updateMessageWithTranscript(
            conversationId,
            messageIndex,
            copy.body,
            filename,
            jobId,
          );
          setConversationTranscriptionPending(null);
          showFailureToast(copy);

          scheduleCleanup({ jobId, blobPath });

          consecutiveFailuresRef.current = 0;
        }
        return;
      }

      // Reset failure counter on successful response
      consecutiveFailuresRef.current = 0;
      setTranscriptionReconnecting(false);

      const responseBody = await response.json();
      // Unwrap API response envelope (successResponse wraps data in { success, data })
      const data: BatchTranscriptionStatusResponse =
        responseBody.data || responseBody;

      // Update progress for chunked transcription jobs
      if (data.progress) {
        console.log(
          `[useTranscriptionPolling] Progress: ${data.progress.completed}/${data.progress.total} chunks ` +
            `(${data.jobType || 'unknown'} job)`,
        );
        updateTranscriptionProgress(
          data.progress.completed,
          data.progress.total,
        );
      }

      // Handle success case
      if (data.status === 'Succeeded' && data.transcript) {
        console.log(
          `[useTranscriptionPolling] Conversation transcription completed: ${filename}`,
        );

        // Check if transcript is large enough to store in blob
        const transcriptSize = new Blob([data.transcript]).size;
        let messageContent: string;

        if (transcriptSize > TRANSCRIPT_BLOB_THRESHOLD) {
          console.log(
            `[useTranscriptionPolling] Large transcript (${transcriptSize} bytes), storing in blob`,
          );

          // Store in blob storage
          const blobRef = await storeTranscriptInBlob(
            jobId,
            data.transcript,
            filename,
            getAbortSignal(),
          );

          if (blobRef) {
            // Use blob reference format that UI can detect and load
            messageContent = `[Transcript: ${filename} | blob:${jobId} | expires:${blobRef.expiresAt}]`;
            console.log(
              `[useTranscriptionPolling] Stored transcript in blob: ${blobRef.blobPath}`,
            );
          } else {
            // Fall back to inline storage if blob upload fails
            console.warn(
              `[useTranscriptionPolling] Blob storage failed, using inline storage`,
            );
            messageContent = `[Transcript: ${filename}]\n${data.transcript}`;
          }
        } else {
          // Small transcript - store inline as before
          messageContent = `[Transcript: ${filename}]\n${data.transcript}`;
        }

        // Update message content with transcript (inline or blob reference)
        updateMessageWithTranscript(
          conversationId,
          messageIndex,
          messageContent,
          filename,
          jobId, // Pass jobId for reliable message matching
        );

        // Auto-activate transcript as active file
        const tokenEstimate = Math.ceil(data.transcript.length / 4);
        const transcriptActiveFile: ActiveFile = {
          id: `transcript-${jobId}-${Date.now()}`,
          url: `transcript://${jobId}/${encodeURIComponent(filename)}`,
          originalFilename: `${filename}.transcript.txt`,
          addedAt: new Date().toISOString(),
          sourceMessageId: '',
          status: 'ready',
          pinned: false,
          processedContent: {
            type: 'transcript',
            content: data.transcript,
            tokenEstimate,
            processedAt: new Date().toISOString(),
          },
        };
        useConversationStore
          .getState()
          .activateFile(conversationId, transcriptActiveFile);

        // Clear pending state
        setConversationTranscriptionPending(null);

        toast.success(t('completedToast', { filename }), {
          duration: 4000,
        });

        // Generate AI title now that transcription is complete
        const conversation = conversations.find((c) => c.id === conversationId);
        if (conversation && conversation.messages.length > 0) {
          generateConversationTitle(
            conversation.messages,
            conversation.model.id,
          )
            .then((result) => {
              if (result?.title) {
                updateConversation(conversationId, { name: result.title });
              }
            })
            .catch((error) => {
              console.error(
                '[useTranscriptionPolling] Failed to generate AI title:',
                error,
              );
            });
        }

        scheduleCleanup({ jobId, blobPath });
      }
      // Handle failure case (including user-initiated cancel, which the
      // server reports as `status: 'Failed'` with `cancelled: true`).
      else if (data.status === 'Failed') {
        const copy = pickFailureCopy(data, filename, t);
        console[copy.neutral ? 'log' : 'error'](
          `[useTranscriptionPolling] Conversation transcription ${
            copy.previewStatus
          }: ${filename}${data.errorClass ? ` (${data.errorClass})` : ''}`,
        );

        updateMessageWithTranscript(
          conversationId,
          messageIndex,
          copy.body,
          filename,
          jobId,
        );

        setConversationTranscriptionPending(null);
        showFailureToast(copy);

        scheduleCleanup({ jobId, blobPath });
      }
      // Running or NotStarted - continue polling
    } catch (error) {
      if (isAbortError(error)) {
        // Hook unmounted while fetch was in flight; stop quietly.
        return;
      }
      consecutiveFailuresRef.current++;
      console.error(
        `[useTranscriptionPolling] Error polling conversation job ${jobId} ` +
          `(failure ${consecutiveFailuresRef.current}/${MAX_CONSECUTIVE_FAILURES}):`,
        error,
      );

      if (consecutiveFailuresRef.current >= RECONNECTING_THRESHOLD) {
        setTranscriptionReconnecting(true);
      }

      // After N consecutive failures, the status channel is effectively dead.
      // Treat as transient so the user sees "please try again" copy.
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        const copy = pickFailureCopy({ errorClass: 'transient' }, filename, t);
        updateMessageWithTranscript(
          conversationId,
          messageIndex,
          copy.body,
          filename,
          jobId,
        );
        setConversationTranscriptionPending(null);
        showFailureToast(copy);

        scheduleCleanup({ jobId, blobPath });

        consecutiveFailuresRef.current = 0;
      }
    }
  }, [
    pendingConversationTranscription,
    t,
    updateMessageWithTranscript,
    setConversationTranscriptionPending,
    updateTranscriptionProgress,
    conversations,
    updateConversation,
    getAbortSignal,
    setTranscriptionReconnecting,
  ]);

  /**
   * Polls the status of all active pre-submit transcription jobs.
   */
  const pollJobs = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;

    try {
      // Poll conversation transcription first
      await pollConversationTranscription();

      const activeJobs = Array.from(pendingTranscriptions.entries()).filter(
        ([, job]) => job.status === 'pending' || job.status === 'processing',
      );

      if (activeJobs.length === 0 && !pendingConversationTranscription) {
        isPollingRef.current = false;
        return;
      }

      for (const [fileId, job] of activeJobs) {
        try {
          const response = await fetch(
            `/api/transcription/status/${job.jobId}`,
            { signal: getAbortSignal() },
          );

          if (!response.ok) {
            console.error(
              `Failed to poll job ${job.jobId}: ${response.status}`,
            );
            continue;
          }

          const responseBody = await response.json();
          // Unwrap API response envelope (successResponse wraps data in { success, data })
          const data: BatchTranscriptionStatusResponse =
            responseBody.data || responseBody;

          // Handle success case
          if (data.status === 'Succeeded' && data.transcript) {
            updateTranscriptionStatus(fileId, 'completed');

            // Update file preview status
            setFilePreviews((prev) =>
              prev.map((p) =>
                p.transcriptionJobId === job.jobId
                  ? { ...p, transcriptionStatus: 'completed' }
                  : p,
              ),
            );

            // Append transcript to text field
            setTextFieldValue((prev) =>
              prev
                ? `${prev}\n\n[Transcript: ${job.filename}]\n${data.transcript}`
                : data.transcript || '',
            );

            toast.success(t('completedToast', { filename: job.filename }), {
              duration: 4000,
            });

            // Remove from pending after a short delay
            setTimeout(() => {
              removePendingTranscription(fileId);
            }, 1000);
          }
          // Handle failure case (including user-initiated cancel).
          else if (data.status === 'Failed') {
            const copy = pickFailureCopy(data, job.filename, t);
            updateTranscriptionStatus(fileId, copy.previewStatus);

            // Update file preview status — neutral 'cancelled' or red 'failed'.
            setFilePreviews((prev) =>
              prev.map((p) =>
                p.transcriptionJobId === job.jobId
                  ? { ...p, transcriptionStatus: copy.previewStatus }
                  : p,
              ),
            );

            showFailureToast(copy);
          }
          // Handle running case - update to processing if not already
          else if (data.status === 'Running' && job.status === 'pending') {
            updateTranscriptionStatus(fileId, 'processing');

            // Update file preview status
            setFilePreviews((prev) =>
              prev.map((p) =>
                p.transcriptionJobId === job.jobId
                  ? { ...p, transcriptionStatus: 'processing' }
                  : p,
              ),
            );
          }
        } catch (error) {
          if (isAbortError(error)) return;
          console.error(`Error polling job ${job.jobId}:`, error);
        }
      }
    } finally {
      isPollingRef.current = false;
    }

    // Schedule next poll if there are still active jobs or conversation transcription
    const stillActiveJobs = Array.from(pendingTranscriptions.entries()).filter(
      ([, job]) => job.status === 'pending' || job.status === 'processing',
    );

    // Check if we still have work to do
    const hasConversationJob = pendingConversationTranscription !== null;
    if (stillActiveJobs.length > 0 || hasConversationJob) {
      // Find the oldest job to determine polling interval
      const startTimes: number[] = [
        ...stillActiveJobs.map(([, job]) => job.startedAt),
      ];
      if (hasConversationJob && pendingConversationTranscription) {
        startTimes.push(pendingConversationTranscription.startedAt);
      }

      const oldestStartTime =
        startTimes.length > 0 ? Math.min(...startTimes) : Date.now();
      const elapsedMs = Date.now() - oldestStartTime;
      const interval = getPollingInterval(elapsedMs);

      timeoutRef.current = setTimeout(pollJobs, interval);
    }
  }, [
    pendingTranscriptions,
    pendingConversationTranscription,
    pollConversationTranscription,
    t,
    updateTranscriptionStatus,
    removePendingTranscription,
    setTextFieldValue,
    setFilePreviews,
    getAbortSignal,
  ]);

  // Start/stop polling based on pending transcriptions (pre-submit or post-submit)
  useEffect(() => {
    const hasActivePreSubmitJobs = Array.from(
      pendingTranscriptions.values(),
    ).some((job) => job.status === 'pending' || job.status === 'processing');

    const hasActiveConversationJob = pendingConversationTranscription !== null;

    if (
      (hasActivePreSubmitJobs || hasActiveConversationJob) &&
      !timeoutRef.current
    ) {
      // Start polling
      pollJobs();
    }

    // Cleanup on unmount
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [pendingTranscriptions, pendingConversationTranscription, pollJobs]);

  // Separate effect for unmount-only abort. Runs once per hook lifetime so
  // in-flight fetches are only canceled when the consumer unmounts — not when
  // pendingTranscriptions changes.
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, []);
}

export default useTranscriptionPolling;
