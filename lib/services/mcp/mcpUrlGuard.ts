/**
 * SSRF guard for user-supplied (non-catalog) MCP server URLs.
 *
 * The implementation now lives in `lib/utils/server/net/publicUrlGuard`, which
 * the workflow page-fetcher shares. This module stays as the MCP-facing entry
 * point so call sites (and the guard's test suite) read as MCP concerns.
 *
 * Note MCP deliberately uses `guardedFetch`, which refuses redirects outright —
 * a 3xx from an MCP transport is always smuggling. Page fetching needs the
 * bounded, re-validated redirect loop in `fetchPublicUrl` instead.
 */

export {
  assertPublicHost,
  guardedFetch,
  isHttpsPublicShapedUrl,
} from '@/lib/utils/server/net/publicUrlGuard';
