import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for user-supplied (non-catalog) MCP server URLs.
 *
 * NOTE: the `ssrf-req-filter` dependency used for image fetching hands back
 * an http.Agent, which Node's undici-based `fetch` (what the MCP SDK uses)
 * does not honor — so the checks here are explicit and run on EVERY request
 * the SDK makes (see guardedFetch), not just the configured base URL. That
 * covers redirects and any follow-up URLs a server response steers to.
 */

/** Private/loopback/link-local/ULA IPv4+IPv6 detector. */
function isPrivateAddress(address: string): boolean {
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
  if (rawUrl.length > 2048) return false;

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
 * guardedFetch this bounds the rebinding window to a single request).
 */
export async function assertPublicHost(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new Error('MCP server host resolves to a non-public address');
    }
    return;
  }
  const addresses = await lookup(host, { all: true });
  if (addresses.length === 0) {
    throw new Error('MCP server host did not resolve');
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error('MCP server host resolves to a non-public address');
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
      throw new Error('Blocked non-public MCP request URL');
    }
    await assertPublicHost(target);
    return baseFetch(input, { ...init, redirect: 'error' });
  };
}
