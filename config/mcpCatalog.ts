import { MCP_SERVER_ID_PATTERN, McpServerRequestEntry } from '@/types/mcp';

/**
 * Curated MCP server catalog — the server-authoritative source of truth for
 * where curated connectors point and how they authenticate.
 *
 * Shared module (no React imports): the settings UI reads the presentation
 * fields (i18n keys, token help URL), the server reads url/transport/auth.
 * Keeping URLs HERE and never trusting a client-sent URL for catalog entries
 * is the security property that makes localStorage-held tokens safe to relay:
 * a tampered settings blob cannot point a GitHub token at an attacker host.
 */
/**
 * How a server authenticates. 'none' = anonymous; 'bearer'/'header' = a
 * user-pasted token relayed per request; 'oauth' = browser-driven OAuth 2.1
 * (PKCE + dynamic client registration), whose ACCESS token is relayed as a
 * Bearer credential exactly like a PAT — the server never distinguishes.
 */
export type McpCatalogAuth =
  | { style: 'none' }
  | { style: 'bearer' }
  | { style: 'header'; headerName: string }
  | { style: 'oauth'; scopes?: string[] };

export interface McpCatalogEntry {
  key: string;
  /** Display label; also the server_label surfaced in stream markers. */
  label: string;
  url: string;
  /** Preferred transport; the client service still falls back HTTP→SSE. */
  transport: 'streamable-http' | 'sse';
  auth: McpCatalogAuth;
  /**
   * bearer/header entries whose server ALSO accepts browser OAuth (PKCE +
   * DCR against the server's published authorization metadata). The UI then
   * offers "Connect with {name}" as the primary affordance with the pasted
   * token as the fallback. Server-side nothing changes: an OAuth access
   * token relays as a Bearer credential exactly like a PAT.
   */
  alsoSupportsOauth?: boolean;
  /** Where the user creates a token (bearer/header styles only). */
  tokenHelpUrl?: string;
  tokenPlaceholder?: string;
  nameKey: string;
  descriptionKey: string;
}

export const MCP_CATALOG: Record<string, McpCatalogEntry> = {
  github: {
    key: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'streamable-http',
    // The hosted github-mcp-server accepts both PATs and OAuth
    // (https://github.com/github/github-mcp-server) — OAuth is the primary
    // affordance in the UI, PAT the fallback.
    auth: { style: 'bearer' },
    alsoSupportsOauth: true,
    tokenHelpUrl: 'https://github.com/settings/personal-access-tokens',
    tokenPlaceholder: 'github_pat_…',
    nameKey: 'connectors.catalog.github.name',
    descriptionKey: 'connectors.catalog.github.description',
  },
  asana: {
    key: 'asana',
    label: 'Asana',
    url: 'https://mcp.asana.com/sse',
    transport: 'sse',
    // Asana's hosted MCP requires OAuth — the browser runs the PKCE flow
    // (see client/services/mcp/mcpOauth.ts) and the resulting access token
    // is relayed as a Bearer credential.
    auth: { style: 'oauth' },
    nameKey: 'connectors.catalog.asana.name',
    descriptionKey: 'connectors.catalog.asana.description',
  },
};

/** A server entry after catalog resolution — safe to hand to the MCP client. */
export interface ResolvedMcpServer {
  id: string;
  /** Display label for markers/records (catalog label or user name). */
  label: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  auth: McpCatalogAuth;
  /** True for catalog entries — these skip the DNS-level SSRF checks. */
  trusted: boolean;
  authToken?: string;
}

export interface ResolveMcpServersOptions {
  /** Whether arbitrary (non-catalog) URLs are allowed at all. */
  allowCustom: boolean;
  /**
   * Validates a custom URL (https-only, public-host shaped). Injected so the
   * pure resolution logic stays testable without DNS. Entries failing it are
   * dropped, not fatal.
   */
  isAllowedCustomUrl: (url: string) => boolean;
}

/**
 * Maps client-sent server entries to executable configs.
 *
 * - `catalogKey` present: url/transport/auth ALWAYS come from the catalog;
 *   any client-sent url is ignored (spoof-proofing). Unknown keys drop.
 * - No `catalogKey`: kept only when custom servers are allowed AND the URL
 *   passes the injected guard.
 *
 * Invalid entries are dropped silently (mirrors /api/agents' degrade-don't-
 * fail handling of invalid sources); the chat must never break because one
 * configured server is bad.
 */
export function resolveMcpServers(
  entries: McpServerRequestEntry[],
  options: ResolveMcpServersOptions,
): ResolvedMcpServer[] {
  const resolved: ResolvedMcpServer[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    if (!MCP_SERVER_ID_PATTERN.test(entry.id) || seenIds.has(entry.id)) {
      continue;
    }

    if (entry.catalogKey !== undefined) {
      const catalogEntry = MCP_CATALOG[entry.catalogKey];
      if (!catalogEntry) continue;
      seenIds.add(entry.id);
      resolved.push({
        id: entry.id,
        label: catalogEntry.label,
        url: catalogEntry.url,
        transport: catalogEntry.transport,
        auth: catalogEntry.auth,
        trusted: true,
        // Belt-and-braces: a 'none'-style server gets no credential even if
        // a (tampered/stale) client entry carries one.
        authToken:
          catalogEntry.auth.style === 'none' ? undefined : entry.authToken,
      });
      continue;
    }

    if (!options.allowCustom) continue;
    if (!entry.url || !options.isAllowedCustomUrl(entry.url)) continue;
    seenIds.add(entry.id);
    resolved.push({
      id: entry.id,
      label: entry.name,
      url: entry.url,
      transport: 'streamable-http',
      auth: { style: 'bearer' },
      trusted: false,
      authToken: entry.authToken,
    });
  }

  return resolved;
}
