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

import { generateConversationTitle } from '@/client/services/titleService';

import {
  BatchTranscriptionStatusResponse,
  TRANSCRIPT_BLOB_THRESHOLD,
  TranscriptReference,
} from '@/types/transcription';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';

/**
 * Stores a large transcript in blob storage and returns a reference.
 * Returns null if storage fails (caller should fall back to inline storage).
 */
async function storeTranscriptInBlob(
  jobId: string,
  transcript: string,
  filename: string,
): Promise<TranscriptReference | null> {
  try {
    const response = await fetch('/api/transcription/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, transcript, filename }),
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
/** Maximum time to wait for transcription (10 minutes) */
const MAX_TRANSCRIPTION_TIME_MS = 10 * 60 * 1000;

export function useTranscriptionPolling(): void {
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

  /** Maximum consecutive failures before giving up and clearing state */
  const MAX_CONSECUTIVE_FAILURES = 5;

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
    } = pendingConversationTranscription;

    // Check for timeout (10 minutes)
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > MAX_TRANSCRIPTION_TIME_MS) {
      console.warn(
        `[useTranscriptionPolling] Transcription timed out for ${filename}`,
      );

      // Update message with timeout error
      updateMessageWithTranscript(
        conversationId,
        messageIndex,
        '[Transcription timed out after 10 minutes]',
        filename,
        jobId, // Pass jobId for reliable message matching
      );

      // Clear pending state
      setConversationTranscriptionPending(null);

      toast.error(`Transcription timed out: ${filename}`, {
        duration: 5000,
      });

      // Cleanup Azure resources
      fetch('/api/transcription/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, blobPath }),
      }).catch(console.warn);

      return;
    }

    try {
      const response = await fetch(`/api/transcription/status/${jobId}`);

      if (!response.ok) {
        consecutiveFailuresRef.current++;
        console.error(
          `[useTranscriptionPolling] Failed to poll conversation job ${jobId}: ${response.status} ` +
            `(failure ${consecutiveFailuresRef.current}/${MAX_CONSECUTIVE_FAILURES})`,
        );

        // After N consecutive failures, assume job is dead and clear state
        if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          updateMessageWithTranscript(
            conversationId,
            messageIndex,
            `[Transcription failed: Unable to retrieve status after ${MAX_CONSECUTIVE_FAILURES} attempts]`,
            filename,
            jobId, // Pass jobId for reliable message matching
          );
          setConversationTranscriptionPending(null);
          toast.error(
            `Transcription failed: ${filename} - Unable to retrieve status`,
            { duration: 5000 },
          );

          // Cleanup Azure resources
          fetch('/api/transcription/cleanup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, blobPath }),
          }).catch(console.warn);

          consecutiveFailuresRef.current = 0;
        }
        return;
      }

      // Reset failure counter on successful response
      consecutiveFailuresRef.current = 0;

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

        // Clear pending state
        setConversationTranscriptionPending(null);

        toast.success(`Transcription complete: ${filename}`, {
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

        // Cleanup Azure resources (batch job + temp blob)
        fetch('/api/transcription/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, blobPath }),
        }).catch(console.warn);
      }
      // Handle failure case
      else if (data.status === 'Failed') {
        console.error(
          `[useTranscriptionPolling] Conversation transcription failed: ${filename}`,
        );

        // Update message with failure error
        updateMessageWithTranscript(
          conversationId,
          messageIndex,
          `[Transcription failed${data.error ? `: ${data.error}` : ''}]`,
          filename,
          jobId, // Pass jobId for reliable message matching
        );

        // Clear pending state
        setConversationTranscriptionPending(null);

        toast.error(
          `Transcription failed: ${filename}${data.error ? ` - ${data.error}` : ''}`,
          { duration: 5000 },
        );

        // Cleanup Azure resources
        fetch('/api/transcription/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, blobPath }),
        }).catch(console.warn);
      }
      // Running or NotStarted - continue polling
    } catch (error) {
      consecutiveFailuresRef.current++;
      console.error(
        `[useTranscriptionPolling] Error polling conversation job ${jobId} ` +
          `(failure ${consecutiveFailuresRef.current}/${MAX_CONSECUTIVE_FAILURES}):`,
        error,
      );

      // After N consecutive failures, assume job is dead and clear state
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        updateMessageWithTranscript(
          conversationId,
          messageIndex,
          `[Transcription failed: Network error after ${MAX_CONSECUTIVE_FAILURES} attempts]`,
          filename,
          jobId, // Pass jobId for reliable message matching
        );
        setConversationTranscriptionPending(null);
        toast.error(`Transcription failed: ${filename} - Network error`, {
          duration: 5000,
        });

        // Cleanup Azure resources
        fetch('/api/transcription/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, blobPath }),
        }).catch(console.warn);

        consecutiveFailuresRef.current = 0;
      }
    }
  }, [
    pendingConversationTranscription,
    updateMessageWithTranscript,
    setConversationTranscriptionPending,
    updateTranscriptionProgress,
    conversations,
    updateConversation,
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

            toast.success(`Transcription complete: ${job.filename}`, {
              duration: 4000,
            });

            // Remove from pending after a short delay
            setTimeout(() => {
              removePendingTranscription(fileId);
            }, 1000);
          }
          // Handle failure case
          else if (data.status === 'Failed') {
            updateTranscriptionStatus(fileId, 'failed');

            // Update file preview status
            setFilePreviews((prev) =>
              prev.map((p) =>
                p.transcriptionJobId === job.jobId
                  ? { ...p, transcriptionStatus: 'failed' }
                  : p,
              ),
            );

            toast.error(
              `Transcription failed: ${job.filename}${data.error ? ` - ${data.error}` : ''}`,
              { duration: 5000 },
            );
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
    updateTranscriptionStatus,
    removePendingTranscription,
    setTextFieldValue,
    setFilePreviews,
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
}

export default useTranscriptionPolling;
