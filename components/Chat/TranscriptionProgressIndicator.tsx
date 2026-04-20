'use client';

import { IconLoader2, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { computeTimeoutMs } from '@/client/hooks/transcription/useTranscriptionPolling';

interface Props {
  /** Timestamp when transcription started */
  startedAt: number;
  /** Filename being transcribed */
  filename: string;
  /**
   * Total chunk count for a chunked job. Used to derive the honest
   * "may take up to N minutes" note. Takes precedence over `maxDurationMs`.
   */
  totalChunks?: number;
  /**
   * Explicit override for the max duration ceiling (ms). Only needed if the
   * caller has special knowledge; prefer passing `totalChunks`.
   */
  maxDurationMs?: number;
  /** Progress for chunked transcription (optional) */
  progress?: {
    completed: number;
    total: number;
  };
  /** Job ID; required to enable the cancel button */
  jobId?: string;
  /** Called when cancellation succeeds (or fails — caller decides UX). */
  onCancel?: () => void;
}

/**
 * Progress indicator component for pending transcriptions.
 * Shows a countdown timer and status message to keep users informed
 * while waiting for large file transcriptions to complete.
 *
 * For chunked transcriptions, also displays progress (X of Y chunks).
 */
export function TranscriptionProgressIndicator({
  startedAt,
  filename,
  totalChunks,
  maxDurationMs,
  progress,
  jobId,
  onCancel,
}: Props) {
  // Honest ceiling: prefer the chunk-count-scaled timeout from the polling
  // hook over a hardcoded 10 minutes. Fall back to the 10-min default only
  // when neither signal is available.
  const effectiveMaxDurationMs =
    maxDurationMs ??
    (totalChunks !== undefined
      ? computeTimeoutMs(totalChunks)
      : 10 * 60 * 1000);
  const t = useTranslations('transcription');
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancel = async () => {
    if (!jobId || isCancelling) return;
    setIsCancelling(true);
    try {
      await fetch(`/api/transcription/cancel/${jobId}`, { method: 'POST' });
    } catch (err) {
      console.warn('[TranscriptionProgressIndicator] Cancel failed:', err);
    } finally {
      // Notify the caller regardless — it will clear local state and the
      // next status poll will confirm server-side cancellation.
      onCancel?.();
      setIsCancelling(false);
    }
  };

  // Snapshot of the last estimate to enable linear countdown between chunk completions
  const lastEstimateRef = useRef<{
    completedChunks: number;
    estimateMs: number;
    timestamp: number;
  } | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      // Always update elapsed time (counts up constantly)
      const elapsed = now - startedAt;
      setElapsedSeconds(Math.floor(elapsed / 1000));

      // No progress data yet - show "??" for remaining time
      if (!progress || progress.total === 0 || progress.completed === 0) {
        setRemainingSeconds(null);
        return;
      }

      // Check if a new chunk has completed since last estimate
      const needsRecalculation =
        !lastEstimateRef.current ||
        lastEstimateRef.current.completedChunks !== progress.completed;

      if (needsRecalculation) {
        // Calculate new estimate based on chunk completion data
        const elapsedMs = now - startedAt;
        const avgTimePerChunk = elapsedMs / progress.completed;
        const remainingChunks = progress.total - progress.completed;
        const baseEstimateMs = remainingChunks * avgTimePerChunk;

        // Apply constant 60% buffer
        const estimatedRemainingMs = baseEstimateMs * 1.6;

        // Cap at maxDuration
        const cappedEstimateMs = Math.min(
          estimatedRemainingMs,
          effectiveMaxDurationMs,
        );

        // Store the snapshot
        lastEstimateRef.current = {
          completedChunks: progress.completed,
          estimateMs: cappedEstimateMs,
          timestamp: now,
        };

        setRemainingSeconds(Math.max(0, Math.ceil(cappedEstimateMs / 1000)));
      } else if (lastEstimateRef.current) {
        // Count down linearly from the last snapshot
        const elapsedSinceSnapshot = now - lastEstimateRef.current.timestamp;
        const remainingMs =
          lastEstimateRef.current.estimateMs - elapsedSinceSnapshot;
        setRemainingSeconds(Math.max(0, Math.ceil(remainingMs / 1000)));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [startedAt, effectiveMaxDurationMs, progress]);

  // Format elapsed time as MM:SS
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  const elapsedSecs = elapsedSeconds % 60;
  const elapsedDisplay = `${elapsedMinutes}:${elapsedSecs.toString().padStart(2, '0')}`;

  // Format remaining time as MM:SS or "??"
  const remainingDisplay =
    remainingSeconds !== null
      ? `${Math.floor(remainingSeconds / 60)}:${(remainingSeconds % 60).toString().padStart(2, '0')}`
      : '??';

  // Calculate progress percentage
  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0;

  return (
    <div className="relative flex flex-col items-center gap-1 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
      {jobId && (
        <button
          type="button"
          onClick={handleCancel}
          disabled={isCancelling}
          aria-label={t('cancel')}
          title={t('cancel')}
          className="absolute top-2 right-2 p-1 rounded-full text-gray-500 hover:text-gray-800 hover:bg-gray-200 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          <IconX size={16} />
        </button>
      )}
      <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
        <IconLoader2 className="animate-spin" size={20} />
        <span className="font-medium">{t('inProgress')}</span>
      </div>
      <div className="text-sm text-gray-600 dark:text-gray-400">
        {t('processingFile', { filename })}
      </div>

      {/* Show chunk progress if available */}
      {progress && progress.total > 1 && progress.completed > 0 && (
        <div className="w-full mt-1">
          <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
            <span>
              Chunk {progress.completed}/{progress.total}
            </span>
            <span>{progressPercent}%</span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className="bg-blue-500 dark:bg-blue-400 h-2 rounded-full transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}

      <div className="text-lg font-mono font-semibold text-blue-700 dark:text-blue-300">
        {t('elapsedTime', { time: elapsedDisplay })} |{' '}
        {t('timeRemaining', { time: remainingDisplay })}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-500">
        {t('maxDurationNote', {
          minutes: Math.ceil(effectiveMaxDurationMs / 60000),
        })}
      </div>
    </div>
  );
}
