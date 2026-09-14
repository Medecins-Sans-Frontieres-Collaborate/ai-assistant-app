/**
 * Azure Document Intelligence (REST, 2024-11-30) — the one client shared by
 * the grants text-extraction stage and the M365 agent OCR engine.
 *
 * Submit → poll `operation-location` (honouring `Retry-After`, capped
 * backoff, abortable, hard timeout) → per-page text. Page text is built
 * from `analyzeResult.pages[].lines[].content` so callers can emit the
 * `--- Page N ---` markers the chunker turns into citation locators; when
 * a page carries no lines, its span of `content` is used instead.
 *
 * Residency: Document Intelligence is a REGIONAL resource. The default
 * endpoint (`AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`) is a single value, so a
 * deployment that serves EU and US users from separate regions must point
 * each region's container at its own DI resource — a scanned EU document
 * must not be analysed in a US region. Callers may pass `endpoint`/`key`
 * explicitly (the grants pipeline does, for its own overrides).
 */
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { env } from '@/config/environment';

export const DOCUMENT_INTELLIGENCE_API_VERSION = '2024-11-30';

export type DocumentIntelligenceModel = 'prebuilt-read' | 'prebuilt-layout';

export type DocumentIntelligenceErrorKind =
  | 'config'
  | 'submit'
  | 'poll'
  | 'failed'
  | 'timeout'
  | 'aborted';

export class DocumentIntelligenceError extends Error {
  constructor(
    message: string,
    readonly kind: DocumentIntelligenceErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DocumentIntelligenceError';
  }
}

export interface AnalyzeDocumentOptions {
  model: DocumentIntelligenceModel;
  /** MIME type of `buffer` (application/pdf, image/png, …). */
  contentType: string;
  /** Override the configured endpoint/key (grants pipeline overrides). */
  endpoint?: string;
  key?: string;
  /**
   * Page selection forwarded as the `pages` query parameter ("1-50",
   * "1,3,5-9"). Only the selected pages are analysed — and billed.
   */
  pages?: string;
  signal?: AbortSignal;
  /** First poll delay when the service sends no Retry-After (default 2 s). */
  pollIntervalMs?: number;
  /** Hard ceiling for submit + polling (default 10 min). */
  timeoutMs?: number;
}

export interface AnalyzedPage {
  pageNumber: number;
  text: string;
}

export interface AnalyzeDocumentResult {
  /** Whole-document text as returned by the service. */
  content: string;
  /** Per-page text in page order (empty pages included with empty text). */
  pages: AnalyzedPage[];
}

interface DiSpan {
  offset: number;
  length: number;
}

interface DiPage {
  pageNumber?: number;
  lines?: Array<{ content?: string }>;
  spans?: DiSpan[];
}

interface DiPollBody {
  status?: string;
  analyzeResult?: { content?: string; pages?: DiPage[] };
  error?: { code?: string; message?: string };
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function configuredEndpoint(override?: string): string {
  return (override ?? env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? '').trim();
}

function configuredKey(override?: string): string {
  return (override ?? env.AZURE_DOCUMENT_INTELLIGENCE_KEY ?? '').trim();
}

/** True when an endpoint AND a key are available (overrides or env). */
export function isDocumentIntelligenceConfigured(overrides?: {
  endpoint?: string;
  key?: string;
}): boolean {
  return (
    configuredEndpoint(overrides?.endpoint) !== '' &&
    configuredKey(overrides?.key) !== ''
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DocumentIntelligenceError('Analysis aborted', 'aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DocumentIntelligenceError('Analysis aborted', 'aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` in ms when present and sane, else null. */
function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_POLL_INTERVAL_MS * 6);
  }
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) {
    return Math.max(0, Math.min(at - Date.now(), MAX_POLL_INTERVAL_MS * 6));
  }
  return null;
}

/**
 * Per-page text. Lines are the readable unit the service already
 * ordered; a page without lines (blank, or a layout model variant) falls
 * back to its content span so nothing is silently dropped.
 */
export function pagesFromAnalyzeResult(
  content: string,
  pages: DiPage[] | undefined,
): AnalyzedPage[] {
  if (!pages || pages.length === 0) {
    return content.trim() ? [{ pageNumber: 1, text: content }] : [];
  }
  return pages.map((page, index) => {
    const pageNumber = page.pageNumber ?? index + 1;
    const lineText = (page.lines ?? [])
      .map((line) => line.content ?? '')
      .filter((line) => line !== '')
      .join('\n');
    if (lineText.trim()) return { pageNumber, text: lineText };
    const spanText = (page.spans ?? [])
      .map((span) => content.slice(span.offset, span.offset + span.length))
      .join('\n');
    return { pageNumber, text: spanText };
  });
}

async function fetchOrThrow(
  input: string,
  init: RequestInit,
  kind: 'submit' | 'poll',
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw new DocumentIntelligenceError('Analysis aborted', 'aborted');
    }
    throw new DocumentIntelligenceError(
      `Document Intelligence ${kind} request failed: ${error instanceof Error ? error.message : String(error)}`,
      kind,
    );
  }
}

/**
 * Analyse one document. Throws {@link DocumentIntelligenceError} with a
 * `kind` the caller can branch on (`config` when nothing is configured —
 * check {@link isDocumentIntelligenceConfigured} first to avoid it).
 */
export async function analyzeDocument(
  buffer: Buffer,
  options: AnalyzeDocumentOptions,
): Promise<AnalyzeDocumentResult> {
  const endpoint = configuredEndpoint(options.endpoint);
  const key = configuredKey(options.key);
  if (!endpoint || !key) {
    throw new DocumentIntelligenceError(
      'Azure Document Intelligence is not configured (endpoint and key required)',
      'config',
    );
  }
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const headers = { 'Ocp-Apim-Subscription-Key': key };

  const query = new URLSearchParams({
    'api-version': DOCUMENT_INTELLIGENCE_API_VERSION,
  });
  if (options.pages) query.set('pages', options.pages);
  const submitUrl = `${endpoint.replace(/\/$/, '')}/documentintelligence/documentModels/${options.model}:analyze?${query.toString()}`;

  const submit = await fetchOrThrow(
    submitUrl,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': options.contentType },
      body: new Uint8Array(buffer),
      signal,
    },
    'submit',
  );
  if (!submit.ok) {
    const body = await submit.text().catch(() => '');
    throw new DocumentIntelligenceError(
      `Document Intelligence submit failed: ${submit.status} ${body.slice(0, 500)}`,
      'submit',
      submit.status,
    );
  }
  const operationLocation = submit.headers.get('operation-location');
  if (!operationLocation) {
    throw new DocumentIntelligenceError(
      'Document Intelligence returned no operation-location header',
      'submit',
      submit.status,
    );
  }

  let delay =
    retryAfterMs(submit) ?? options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  for (;;) {
    if (Date.now() + delay > deadline) {
      throw new DocumentIntelligenceError(
        `Document Intelligence analysis timed out after ${Math.round(timeoutMs / 1000)}s`,
        'timeout',
      );
    }
    await sleep(delay, signal);
    const poll = await fetchOrThrow(
      operationLocation,
      { headers, signal },
      'poll',
    );
    if (poll.status === 429 || poll.status >= 500) {
      // Transient: keep polling with the service's hint or backoff.
      delay = retryAfterMs(poll) ?? Math.min(delay * 1.5, MAX_POLL_INTERVAL_MS);
      continue;
    }
    if (!poll.ok) {
      throw new DocumentIntelligenceError(
        `Document Intelligence poll failed: ${poll.status}`,
        'poll',
        poll.status,
      );
    }
    const body = (await poll.json().catch(() => ({}))) as DiPollBody;
    if (body.status === 'succeeded') {
      const content = body.analyzeResult?.content ?? '';
      return {
        content,
        pages: pagesFromAnalyzeResult(content, body.analyzeResult?.pages),
      };
    }
    if (body.status === 'failed') {
      throw new DocumentIntelligenceError(
        `Document Intelligence analysis failed: ${body.error?.message ?? body.error?.code ?? 'unknown error'}`,
        'failed',
      );
    }
    console.log(
      `[document-intelligence] ${options.model} ${sanitizeForLog(body.status ?? 'pending')}, polling again in ${delay}ms`,
    );
    delay = retryAfterMs(poll) ?? Math.min(delay * 1.5, MAX_POLL_INTERVAL_MS);
  }
}
