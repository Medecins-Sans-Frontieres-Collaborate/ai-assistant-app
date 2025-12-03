import { useCallback, useEffect, useRef, useState } from 'react';
import documentService from '@/services/documentService';
import {
  DocumentResponse,
  DocumentTranslationResponse,
  DocumentTranslationStatusResponse,
} from '@/types/document';

type Status = 'idle' | 'uploading' | 'translating' | 'completed' | 'failed' | 'canceled' | 'polling';

export function useDocumentTranslation() {
  const [status, setStatus] = useState<Status>('idle');
  const [document, setDocument] = useState<DocumentResponse | null>(null);
  const [translation, setTranslation] = useState<DocumentTranslationResponse | null>(null);
  const [jobStatus, setJobStatus] = useState<DocumentTranslationStatusResponse | null>(null);
  const pollingRef = useRef<{ canceled: boolean }>({ canceled: false });

  useEffect(() => {
    return () => {
      pollingRef.current.canceled = true;
    };
  }, []);

  const upload = useCallback(async (file: File | Blob, metadata?: Record<string, any>) => {
    setStatus('uploading');
    try {
      const doc = await documentService.uploadDocument(file, undefined, metadata);
      setDocument(doc);
      setStatus('idle');
      return doc;
    } catch (err) {
      setStatus('failed');
      throw err;
    }
  }, []);

  const startTranslation = useCallback(async (params: { document_id: number; user_id: string | number; target_lang: string; source_lang?: string }, onStatusUpdate?: (s: DocumentTranslationStatusResponse) => void) => {
    setStatus('translating');
    try {
      const resp = await documentService.translateDocument({
        document_id: params.document_id,
        user_id: params.user_id,
        source_lang: params.source_lang,
        target_lang: params.target_lang,
      });
      setTranslation(resp);
      setStatus('polling');
      // start polling
      pollStatus(resp.job_id, onStatusUpdate).catch((e) => {
        // failures handled inside pollStatus
      });
      return resp;
    } catch (err) {
      setStatus('failed');
      throw err;
    }
  }, []);

  const pollStatus = useCallback(async (jobId: string, onStatusUpdate?: (s: DocumentTranslationStatusResponse) => void) => {
    pollingRef.current.canceled = false;
    const start = Date.now();
    const maxElapsed = 10 * 60 * 1000; // 10 minutes
    let attempt = 0;
    const delays = [2000, 4000, 8000, 16000, 30000];

    while (!pollingRef.current.canceled) {
      try {
        const s = await documentService.getTranslationStatus(jobId);
        setJobStatus(s);
        onStatusUpdate?.(s);
        if (s.status === 'Succeeded' || s.status === 'Failed') {
          setStatus(s.status === 'Succeeded' ? 'completed' : 'failed');
          return s;
        }
        // continue polling
      } catch (err) {
        // transient error: continue with backoff
        console.error('[useDocumentTranslation] pollStatus error', err);
      }

      attempt = Math.min(attempt + 1, delays.length - 1);
      const delay = delays[Math.min(attempt, delays.length - 1)];
      // stop if exceeded max elapsed
      if (Date.now() - start > maxElapsed) {
        setStatus('failed');
        throw new Error('Translation status polling timed out');
      }
      await new Promise((res) => setTimeout(res, delay));
    }
    setStatus('canceled');
    throw new Error('Polling canceled');
  }, []);

  const cancelPolling = useCallback(() => {
    pollingRef.current.canceled = true;
    setStatus('canceled');
  }, []);

  const download = useCallback(async (blobName: string, source = false) => {
    const blob = await documentService.downloadBlob(blobName, source);
    return blob;
  }, []);

  return {
    status,
    document,
    translation,
    jobStatus,
    upload,
    startTranslation,
    pollStatus,
    cancelPolling,
    download,
  } as const;
}

export default useDocumentTranslation;
