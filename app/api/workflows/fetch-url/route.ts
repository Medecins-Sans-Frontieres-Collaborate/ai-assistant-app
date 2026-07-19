import { NextRequest } from 'next/server';

import { extractReadableContent } from '@/lib/services/workflows/shared/articleExtraction';

import {
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import {
  FetchUrlError,
  isFetchUrlError,
} from '@/lib/utils/server/net/fetchUrlError';
import {
  fetchPublicUrl,
  readBodyWithLimit,
} from '@/lib/utils/server/net/publicUrlGuard';

import { auth } from '@/auth';

/**
 * POST /api/workflows/fetch-url — reads a user-supplied web page and returns
 * its main prose, so a workflow can map/translate/analyse a link the same way
 * it handles pasted text.
 *
 * Deliberately separate from the workflow routes that consume it: a fetch
 * failure needs its own message ("copy the text and paste it instead"), and
 * keeping it standalone lets any workflow reuse it.
 *
 * Fetching arbitrary user URLs server-side is an SSRF sink — every hop goes
 * through the public-host guard in `publicUrlGuard`.
 */

// One bounded fetch plus at most one cleanup model call.
export const maxDuration = 60;

const MAX_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/json',
]);
/** Servers that decline to commit; we sniff the bytes instead. */
const AMBIGUOUS_TYPES = new Set(['', 'application/octet-stream']);

interface FetchUrlRequest {
  url?: string;
  /** Preferred model for the cleanup fallback; ineligible ids fall back. */
  modelId?: string;
}

/** Upstream HTTP status → the advice the user actually needs. */
function assertUpstreamOk(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403 || status === 429) {
    throw new FetchUrlError('BLOCKED', `Site refused the request (${status})`);
  }
  if (status === 404 || status === 410) {
    throw new FetchUrlError('NOT_FOUND', `Page not found (${status})`);
  }
  throw new FetchUrlError('UPSTREAM_ERROR', `Site returned ${status}`);
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 1024))
    .toLowerCase();
  return head.includes('<html') || head.includes('<!doctype html');
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return unauthorizedResponse();

  let body: FetchUrlRequest;
  try {
    body = (await req.json()) as FetchUrlRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400, undefined, 'INVALID_URL');
  }

  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl) {
    return errorResponse('A URL is required', 400, undefined, 'INVALID_URL');
  }

  try {
    const { response, resolvedUrl } = await fetchPublicUrl(rawUrl, {
      timeoutMs: FETCH_TIMEOUT_MS,
    });

    assertUpstreamOk(response.status);

    const contentType = response.headers.get('content-type') ?? '';
    const mime = contentType.split(';')[0].trim().toLowerCase();

    if (mime === 'application/pdf') {
      await response.body?.cancel().catch(() => {});
      throw new FetchUrlError('PDF', 'Link points at a PDF');
    }
    if (
      !HTML_TYPES.has(mime) &&
      !TEXT_TYPES.has(mime) &&
      !AMBIGUOUS_TYPES.has(mime)
    ) {
      await response.body?.cancel().catch(() => {});
      throw new FetchUrlError('NON_HTML', `Unsupported content type: ${mime}`);
    }

    const bytes = await readBodyWithLimit(response, MAX_BYTES);

    // Mislabelled downloads are common; trust the bytes over the header.
    if (looksLikePdf(bytes)) {
      throw new FetchUrlError('PDF', 'Link points at a PDF');
    }

    const isHtml = HTML_TYPES.has(mime) || looksLikeHtml(bytes);

    const extracted = await extractReadableContent({
      bytes,
      contentType,
      resolvedUrl,
      isHtml,
      modelId: body.modelId,
    });

    return successResponse({
      text: extracted.text,
      title: extracted.title,
      siteName: extracted.siteName,
      resolvedUrl,
      truncated: extracted.truncated,
      extractedVia: extracted.extractedVia,
    });
  } catch (error) {
    if (isFetchUrlError(error)) {
      return errorResponse(error.message, error.status, undefined, error.code);
    }
    console.error('[workflows/fetch-url] Failed:', error);
    return errorResponse(
      'The page could not be fetched',
      502,
      undefined,
      'UNREACHABLE',
    );
  }
}
