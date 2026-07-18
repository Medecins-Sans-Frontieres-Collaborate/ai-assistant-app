import { FetchUrlError } from './fetchUrlError';

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for user-supplied URLs — MCP server endpoints and, via
 * `fetchPublicUrl`, arbitrary web pages the user asks a workflow to read.
 *
 * NOTE: the `ssrf-req-filter` dependency used for image fetching hands back
 * an http.Agent, which Node's undici-based `fetch` does not honor — so the
 * checks here are explicit and run on EVERY request, not just the first URL.
 * That covers redirects and any follow-up URLs a response steers to.
 */

/** Private/loopback/link-local/ULA IPv4+IPv6 detector. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return (
      a === 0 || // 0.0.0.0/8 "this network"
      a === 10 || // 10.0.0.0/8
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
      a >= 224 // multicast + reserved
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified/loopback
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    if (/^f[cd]/.test(lower)) return true; // ULA fc00::/7
    if (lower.startsWith('::ffff:')) {
      // v4-mapped — recheck the embedded IPv4. The URL parser emits the hex
      // form (::ffff:c0a8:1), resolvers may emit dotted (::ffff:192.168.0.1).
      const rest = lower.slice('::ffff:'.length);
      if (isIP(rest) === 4) return isPrivateAddress(rest);
      const groups = rest.split(':');
      if (groups.length <= 2) {
        const hi = parseInt(groups.length === 2 ? groups[0] : '0', 16);
        const lo = parseInt(groups[groups.length - 1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          return isPrivateAddress(
            `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`,
          );
        }
      }
      return true; // unparseable mapped form — fail closed
    }
    return false;
  }
  return false;
}

const BLOCKED_HOSTNAME = /(^|\.)(localhost|local|internal|home\.arpa)$/i;

export const MAX_URL_LENGTH = 2048;

/**
 * Pure (no I/O) shape check: https-only, no credentials in the URL, no
 * private/loopback IP literals, no localhost-ish hostnames.
 */
export function isHttpsPublicShapedUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (rawUrl.length > MAX_URL_LENGTH) return false;

  // URL brackets IPv6 hosts; strip for isIP.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAME.test(host)) return false;
  if (isIP(host) && isPrivateAddress(host)) return false;
  return true;
}

/**
 * Async DNS check: every address the hostname resolves to must be public.
 * Catches private hosts hiding behind public-looking names (incl. DNS
 * rebinding at resolution time — combined with per-request re-validation in
 * guardedFetch/fetchPublicUrl this bounds the rebinding window to a single
 * request).
 */
export async function assertPublicHost(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error('Host resolves to a non-public address');
    }
    return;
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) {
    throw new Error('Host did not resolve');
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('Host resolves to a non-public address');
    }
  }
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Fetch wrapper handed to the MCP SDK transports for UNTRUSTED (arbitrary)
 * servers. Re-validates every request URL — the SDK issues follow-up
 * requests (SSE endpoints, session URLs) beyond the configured base — and
 * refuses redirects outright so a 3xx can't smuggle a request elsewhere.
 */
export function guardedFetch(baseFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const target = typeof input === 'string' ? input : input.toString();
    if (!isHttpsPublicShapedUrl(target)) {
      throw new Error('Blocked non-public request URL');
    }
    await assertPublicHost(target);
    return baseFetch(input, { ...init, redirect: 'error' });
  };
}

/* ------------------------------------------------------------------ */
/* Page fetching                                                       */
/* ------------------------------------------------------------------ */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Accepts what a person would actually paste. Bare `example.com/x` gains a
 * scheme, and `http://` is upgraded rather than refused — the overwhelming
 * majority of sites redirect to https anyway, and we never want to fetch
 * cleartext on the user's behalf.
 */
export function normalizeInputUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) {
    throw new FetchUrlError('INVALID_URL', 'URL is empty or too long');
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new FetchUrlError('INVALID_URL', 'URL could not be parsed');
  }
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') {
    throw new FetchUrlError('INVALID_URL', 'Only http(s) URLs can be fetched');
  }
  return url.toString();
}

export interface FetchPublicUrlOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxHops?: number;
  headers?: Record<string, string>;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (compatible; AI-Assistant-Workflow/1.0; +user-initiated page read)',
  Accept:
    'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1',
  'Accept-Language': 'en',
};

/**
 * Fetches a user-supplied page, re-running the SSRF guard before every hop.
 *
 * `guardedFetch`'s blanket `redirect: 'error'` is right for MCP (a 3xx there
 * is always smuggling) but wrong for the open web, where http→https, www,
 * canonical and trailing-slash redirects are routine. So redirects are
 * followed manually, bounded, and re-validated — a redirect to
 * 169.254.169.254 is the classic cloud-metadata SSRF and must not survive.
 */
export async function fetchPublicUrl(
  rawUrl: string,
  options: FetchPublicUrlOptions = {},
): Promise<{ response: Response; resolvedUrl: string }> {
  const {
    fetchImpl = fetch,
    timeoutMs = 15_000,
    maxHops = 5,
    headers = DEFAULT_HEADERS,
  } = options;

  // One signal for the whole chain, so total wall time is bounded no matter
  // how many hops a site sends us through.
  const signal = AbortSignal.timeout(timeoutMs);
  const visited = new Set<string>();
  let current = normalizeInputUrl(rawUrl);

  for (let hop = 0; hop < maxHops; hop += 1) {
    if (!isHttpsPublicShapedUrl(current)) {
      throw new FetchUrlError('SSRF_BLOCKED', 'Blocked non-public request URL');
    }
    try {
      await assertPublicHost(current);
    } catch (err) {
      throw new FetchUrlError(
        'SSRF_BLOCKED',
        err instanceof Error ? err.message : 'Host is not public',
      );
    }
    if (visited.has(current)) {
      throw new FetchUrlError('TOO_MANY_REDIRECTS', 'Redirect loop detected');
    }
    visited.add(current);

    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        signal,
        headers,
        credentials: 'omit',
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new FetchUrlError('TIMEOUT', 'The page took too long to respond');
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetchUrlError('TIMEOUT', 'The page took too long to respond');
      }
      throw new FetchUrlError(
        'UNREACHABLE',
        err instanceof Error ? err.message : 'Request failed',
      );
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response, resolvedUrl: current };
    }

    const location = response.headers.get('location');
    // Don't leave the redirect body dangling on the connection.
    await response.body?.cancel().catch(() => {});
    if (!location) {
      throw new FetchUrlError('UNREACHABLE', 'Redirect without a location');
    }

    let next: URL;
    try {
      // Relative Location resolves against the CURRENT hop, not the original.
      next = new URL(location, current);
    } catch {
      throw new FetchUrlError('UNREACHABLE', 'Redirect location is invalid');
    }
    if (next.protocol !== 'https:') {
      throw new FetchUrlError(
        'SSRF_BLOCKED',
        'Redirect left https for a non-public scheme',
      );
    }
    current = next.toString();
  }

  throw new FetchUrlError('TOO_MANY_REDIRECTS', 'Too many redirects');
}

/**
 * Reads a response body, refusing to buffer more than `maxBytes`.
 *
 * Streams rather than trusting `content-length`, which is absent on chunked
 * responses and can simply lie.
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new FetchUrlError('TOO_LARGE', 'Page exceeds the size limit');
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchUrlError('TOO_LARGE', 'Page exceeds the size limit');
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
