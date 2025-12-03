import {
  DocumentResponse,
  DocumentTranslationResponse,
  DocumentTranslationStatusResponse,
  DocumentCostResponse,
  TranslateDocumentRequest,
} from '@/types/document';

const DEFAULT_BASE = 'https://msfintl-ams-dev-trans-app.azurewebsites.net';

function getBaseUrl(): string {
  return process?.env?.DOCUMENT_TRANSLATOR_BASE_URL || DEFAULT_BASE;
}

function getApiKeyHeader(): { [k: string]: string } {
  const header = process?.env?.DOCUMENT_TRANSLATOR_API_KEY_HEADER || 'x-api-key';
  const key = process?.env?.DOCUMENT_TRANSLATOR_API_KEY || '';
  return key ? { [header]: key } : {};
}

async function handleResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message = json?.message || json?.error || text || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return json as T;
  } catch (err) {
    if (!res.ok) {
      throw new Error(text || `HTTP ${res.status}`);
    }
    // parse error but OK response -> return as any
    // @ts-ignore
    return text as T;
  }
}

export async function uploadDocument(
  file: File | Blob,
  filename?: string,
  metadata?: Record<string, string | number | boolean>,
): Promise<DocumentResponse> {
  const base = getBaseUrl();
  const url = `${base}/document/upload`;
  const form = new FormData();
  form.append('file', file, filename || (file instanceof File ? file.name : 'upload'));
  if (metadata) {
    Object.keys(metadata).forEach((k) => {
      const v = metadata[k];
      if (v !== undefined && v !== null) form.append(k, String(v));
    });
  }

  const headers = getApiKeyHeader();

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    // credentials left to default; adapt if cookie-based auth is required
  });

  return handleResponse<DocumentResponse>(res);
}

export async function translateDocument(
  params: TranslateDocumentRequest,
): Promise<DocumentTranslationResponse> {
  const base = getBaseUrl();
  const url = `${base}/document/translate`;

  const body = new URLSearchParams();
  body.append('document_id', String(params.document_id));
  body.append('user_id', String(params.user_id));
  if (params.source_lang) body.append('source_lang', params.source_lang);
  body.append('target_lang', params.target_lang);

  const headers = Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, getApiKeyHeader());

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  return handleResponse<DocumentTranslationResponse>(res);
}

export async function getTranslationStatus(jobId: string): Promise<DocumentTranslationStatusResponse> {
  const base = getBaseUrl();
  const url = `${base}/document/translate/status/${encodeURIComponent(jobId)}`;
  const headers = getApiKeyHeader();

  const res = await fetch(url, { method: 'GET', headers });
  return handleResponse<DocumentTranslationStatusResponse>(res);
}

export async function downloadBlob(blobName: string, source: boolean = false): Promise<Blob> {
  const base = getBaseUrl();
  const url = new URL(`${base}/document/download`);
  url.searchParams.set('blob_name', blobName);
  if (source) url.searchParams.set('source', 'true');

  const headers = getApiKeyHeader();
  const res = await fetch(url.toString(), { method: 'GET', headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Download failed ${res.status}`);
  }
  return res.blob();
}

export async function estimateTranslationCost(documentId: number, sourceLang?: string, targetLang?: string): Promise<DocumentCostResponse> {
  const base = getBaseUrl();
  const url = `${base}/document/cost`;
  const body = new URLSearchParams();
  body.append('document_id', String(documentId));
  if (sourceLang) body.append('source_lang', sourceLang);
  if (targetLang) body.append('target_lang', targetLang);

  const headers = Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, getApiKeyHeader());

  const res = await fetch(url, { method: 'POST', headers, body: body.toString() });
  return handleResponse<DocumentCostResponse>(res);
}

const documentService = {
  uploadDocument,
  translateDocument,
  getTranslationStatus,
  downloadBlob,
  estimateTranslationCost,
};

export default documentService;
