import {
  DocumentUploadResponse,
  DocumentTranslationResponse,
  DocumentTranslationStatusResponse,
  DocumentCostResponse,
  DocumentTranslationRequest,
} from '@/types/document';

const LOCAL_PROXY_BASE = '/api/v2/document-translation';

export async function translateDocument(
  payload: DocumentTranslationRequest,
): Promise<DocumentTranslationResponse> {
  const formData = new FormData();
  formData.append('file', payload.file);
  formData.append('sourceLanguage', payload.sourceLanguage);
  formData.append('targetLanguage', payload.sourceLanguage);

  const res = await fetch('/api/v2/document-translation', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    let message = 'Failed to start document translation';
    try {
      const err = await res.json();
      message =
        err?.error ??
        err?.backend?.message ??
        err?.backend?.detail ??
        message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const json = (await res.json()) as DocumentTranslationResponse;
  return json;
}

export async function getDocumentTranslationStatus(
  jobId: string,
): Promise<DocumentTranslationStatusResponse> {
  const res = await fetch(
    `/api/v2/document-translation/${encodeURIComponent(jobId)}`,
    {
      method: 'GET',
    },
  );

  if (!res.ok) {
    let message = 'Failed to fetch document translation status';
    try {
      const err = await res.json();
      message =
        err?.error ??
        err?.backend?.message ??
        err?.backend?.detail ??
        message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  return (await res.json()) as DocumentTranslationStatusResponse;
}

const documentService = {
  translateDocument,
  getDocumentTranslationStatus,
};

export default documentService;
