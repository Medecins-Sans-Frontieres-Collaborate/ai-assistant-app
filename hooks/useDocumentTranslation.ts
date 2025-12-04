import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DocumentTranslationResponse,
  DocumentTranslationStatusResponse,
  DocumentTranslationRequest,
} from '@/types/document';
import {
  translateDocument,
  getDocumentTranslationStatus,
} from '@/services/documentService';

type TranslationPhase = 'idle' | 'starting' | 'running' | 'completed' | 'failed';

interface UseDocumentTranslationOptions {
  pollIntervalMs?: number;
}

export function useDocumentTranslationWithStatus(
  options: UseDocumentTranslationOptions = {},
) {
  const { pollIntervalMs = 2000 } = options;

  const [phase, setPhase] = useState<TranslationPhase>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [startResponse, setStartResponse] =
    useState<DocumentTranslationResponse | null>(null);
  const [status, setStatus] =
    useState<DocumentTranslationStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearPollTimer = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const stopPolling = useCallback(() => {
    clearPollTimer();
    setIsPolling(false);
  }, []);

  const startPolling = useCallback(
    (jobIdToPoll: string) => {
      clearPollTimer();
      setIsPolling(true);
      setPhase('running');

      const tick = async () => {
        try {
          const s = await getDocumentTranslationStatus(jobIdToPoll);
          setStatus(s);

          const isDone =
            s.succeeded ||
            s.status.toLowerCase() === 'completed' ||
            s.status.toLowerCase() === 'failed';

          if (isDone) {
            stopPolling();
            setPhase(s.succeeded ? 'completed' : 'failed');
          }
        } catch (err) {
          console.error('[useDocumentTranslationWithStatus] poll error', err);
          stopPolling();
          setPhase('failed');
          const msg =
            err instanceof Error ? err.message : 'Failed to poll translation';
          setError(msg);
        }
      };

      // immediate first tick
      void tick();

      pollTimerRef.current = setInterval(() => {
        void tick();
      }, pollIntervalMs);
    },
    [pollIntervalMs, stopPolling],
  );

  const startTranslation = useCallback(
    async (payload: DocumentTranslationRequest) => {
      setPhase('starting');
      setError(null);
      setStatus(null);
      setStartResponse(null);
      setJobId(null);

      try {
        const resp = await translateDocument(payload);
        setStartResponse(resp);

        if (!resp.job_id) {
          throw new Error('Translation response missing job_id');
        }

        setJobId(resp.job_id);
        startPolling(resp.job_id);

        return resp;
      } catch (err) {
        console.error('[useDocumentTranslationWithStatus] start error', err);
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to start document translation';
        setError(msg);
        setPhase('failed');
        throw err;
      }
    },
    [startPolling],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearPollTimer();
    };
  }, []);

  return {
    // actions
    startTranslation,
    stopPolling,

    // state
    phase,
    jobId,
    startResponse, // contains job_id + target_sas_url
    status, // live backend status
    error,
    isPolling,
  };
}