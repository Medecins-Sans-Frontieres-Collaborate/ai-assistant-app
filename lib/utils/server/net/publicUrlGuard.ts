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

/**
 * Expands any IPv6 spelling — `::` compression, embedded dotted quad — into
 * exactly 8 numeric hextets, so ranges can be tested numerically instead of
 * by string prefix. Returns null if the input isn't a parseable IPv6 literal;
 * callers treat that as private (fail closed).
 */
function expandIpv6(address: string): number[] | null {
  let text = address;

  // A trailing dotted quad (::ffff:192.168.0.1) becomes two hextets.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIP(tail) === 4) {
    const [o0, o1, o2, o3] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${(((o0 << 8) | o1) >>> 0).toString(16)}:${(((o2 << 8) | o3) >>> 0).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const parse = (part: string): string[] => (part ? part.split(':') : []);
  const head = parse(halves[0]);
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const rear = parse(halves[1]);
    const missing = 8 - head.length - rear.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill('0'), ...rear];
  }
  if (groups.length !== 8) return null;

  const hextets = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  return hextets.some(Number.isNaN) ? null : hextets;
}

/** Private/loopback/link-local/ULA IPv4+IPv6 detector. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    return (
      a === 0 || // 0.0.0.0/8 "this network"
      a === 10 || // 10.0.0.0/8
      a === 127 || // loopback
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
      (a === 192 && b === 0 && c === 2) || // TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
      (a === 198 && b === 51 && c === 100) || // TEST-NET-2
      (a === 203 && b === 0 && c === 113) || // TEST-NET-3
      (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
      a >= 224 // multicast + reserved
    );
  }
  if (version === 6) {
    const g = expandIpv6(address.toLowerCase());
    if (!g) return true; // unparseable — fail closed

    const embedded = (hi: number, lo: number) =>
      `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    const zeros = (upTo: number) => g.slice(0, upTo).every((x) => x === 0);

    if (zeros(8)) return true; // :: unspecified
    if (zeros(7) && g[7] === 1) return true; // ::1 loopback

    // Forms that carry an IPv4 address inside them: recheck the embedded v4,
    // or ::ffff:127.0.0.1 / 64:ff9b::169.254.169.254 walk straight past us.
    if (zeros(5) && g[5] === 0xffff)
      return isPrivateAddress(embedded(g[6], g[7])); // v4-mapped
    if (zeros(6)) return isPrivateAddress(embedded(g[6], g[7])); // v4-compatible ::a.b.c.d
    if (g[0] === 0x0064 && g[1] === 0xff9b) {
      return isPrivateAddress(embedded(g[6], g[7])); // NAT64 64:ff9b::/96 + /48
    }
    if (g[0] === 0x2002) return isPrivateAddress(embedded(g[1], g[2])); // 6to4 2002::/16

    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo 2001::/32
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
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
