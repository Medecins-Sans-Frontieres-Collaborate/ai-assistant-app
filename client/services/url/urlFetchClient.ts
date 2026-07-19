/**
 * Shared client helpers for "the user gave us a link" — detection, error
 * message mapping, and turning a fetched page into an attachable file.
 *
 * Used by the chat composer, the Map workflow, and workflow reference inputs,
 * so nothing here may depend on a particular feature's state or i18n scope.
 * All strings live under the top-level `urlFetch` namespace.
 */
import type { FetchUrlErrorCode } from '@/lib/utils/server/net/fetchUrlError';

const MAX_URL_LENGTH = 2048;

const BARE_DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i;

/**
 * Document extensions that look exactly like a bare domain. Someone typing
 * `notes.md` wants the attach button, not a fetch.
 */
const FILE_EXTENSIONS = new Set([
  'txt',
  'md',
  'pdf',
  'doc',
  'docx',
  'csv',
  'json',
  'xlsx',
  'xls',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'zip',
]);

/**
 * Whether a string should be treated as a link rather than as prose.
 * Intentionally strict — this drives an automatic network fetch, so the bar
 * for a false positive is higher than for a mere UI hint.
 */
export function isLikelyUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return false;
  if (/\s/.test(trimmed)) return false;

  let host: string;
  let hadScheme = false;

  if (/^https?:\/\//i.test(trimmed)) {
    hadScheme = true;
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return false;
    }
  } else if (BARE_DOMAIN.test(trimmed)) {
    host = trimmed.split(/[/?#]/)[0];
  } else {
    return false;
  }

  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return false;

  const tld = labels[labels.length - 1].toLowerCase();
  if (!/^[a-z]{2,}$/.test(tld)) return false;
  // With an explicit scheme the user has been unambiguous.
  if (!hadScheme && FILE_EXTENSIONS.has(tld)) return false;

  return true;
}

/** Display host for a fetched page, without the noise of a `www.` prefix. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

const ERROR_KEYS: Record<FetchUrlErrorCode, string> = {
  INVALID_URL: 'invalidUrl',
  SSRF_BLOCKED: 'ssrfBlocked',
  TOO_MANY_REDIRECTS: 'tooManyRedirects',
  TIMEOUT: 'timeout',
  UNREACHABLE: 'unreachable',
  BLOCKED: 'blocked',
  NOT_FOUND: 'notFound',
  UPSTREAM_ERROR: 'upstream',
  PDF: 'pdf',
  NON_HTML: 'nonHtml',
  TOO_LARGE: 'tooLarge',
  EMPTY_EXTRACTION: 'empty',
};

export const URL_ERROR_KEYS = ERROR_KEYS;

/**
 * Maps a server error code to its leaf key under the `urlFetch.errors`
 * namespace. Unknown codes fall back to `generic`, so a newly added server
 * code degrades to a sensible message instead of rendering a raw key.
 */
export function urlErrorKey(code?: string): string {
  const leaf = (code && ERROR_KEYS[code as FetchUrlErrorCode]) || 'generic';
  return `errors.${leaf}`;
}

export interface FetchedPage {
  text: string;
  title: string;
  siteName: string;
  resolvedUrl: string;
  truncated: boolean;
  extractedVia: string;
}

export type UrlFetchResult =
  | { ok: true; page: FetchedPage }
  | { ok: false; code: string };

/**
 * Upper bound matching the route's own `maxDuration`. A caller may be showing
 * an in-flight attachment that blocks sending, so this request must always
 * terminate — a wedged fetch would wedge the composer with it.
 */
const CLIENT_TIMEOUT_MS = 60_000;

/**
 * Calls the page-fetch route. Never throws — a network failure is reported as
 * a code like any server-side failure, because callers render both the same
 * way and must not be able to leave an attachment stuck in flight.
 */
export async function fetchUrlContent(
  url: string,
  options: { modelId?: string; signal?: AbortSignal } = {},
): Promise<UrlFetchResult> {
  try {
    const response = await fetch('/api/workflows/fetch-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, modelId: options.modelId }),
      signal: options.signal ?? AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    const parsed = await response.json();
    if (!response.ok || !parsed?.success) {
      return { ok: false, code: String(parsed?.code ?? 'UNREACHABLE') };
    }
    return { ok: true, page: parsed.data as FetchedPage };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    return { ok: false, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE' };
  }
}
