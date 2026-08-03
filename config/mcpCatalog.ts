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
  /**
   * Server publishes a usable web-app registration endpoint, so browser DCR
   * can mint a client on the fly and no MCP_OAUTH_<VENDOR>_CLIENT_ID is
   * required. Most vendors do NOT (see getStaticOauthClient) — for those the
   * settings UI hides "Connect with {name}" until an app is configured,
   * because the click could only ever end in OAUTH_DCR_UNSUPPORTED.
   */
  supportsDynamicRegistration?: boolean;
  /**
   * OAuth scopes to request on the authorization call whenever this entry
   * connects via OAuth (style 'oauth' or alsoSupportsOauth). Absent = no
   * scope parameter, which for many vendors means their default grant —
   * for GitHub that is READ-ONLY PUBLIC access, so entries whose tools need
   * more must spell their scopes out here. Users who connected before a
   * scope change keep their old grant until they reconnect.
   */
  oauthScopes?: string[];
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
    // Without a scope parameter a GitHub OAuth token sees PUBLIC data only —
    // private issues/repos silently come back empty. Classic OAuth scopes
    // have no read-only private option: `repo` (read AND write) is the only
    // way to reach private repos/issues/PRs; read-only granularity would
    // require a GitHub App instead of an OAuth app. NOTE: private ORG repos
    // additionally need the OAuth app approved under the org's third-party
    // access policy.
    oauthScopes: ['repo', 'read:org', 'read:user'],
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
  tableau: {
    key: 'tableau',
    label: 'Tableau',
    // Single non-templated host with pod-aware routing — works for every
    // Tableau Cloud pod. Tableau SERVER (self-hosted) is NOT covered; those
    // customers must self-deploy tableau/tableau-mcp and add it as a custom
    // server. https://tableau.github.io/tableau-mcp/docs/hosted-tableau-mcp
    url: 'https://mcp.tableau.com',
    transport: 'streamable-http',
    // OAuth 2.1 — the only connector in this batch that may complete DCR
    // unaided, so the static app env vars are a fallback, not a requirement.
    auth: { style: 'oauth' },
    supportsDynamicRegistration: true,
    nameKey: 'connectors.catalog.tableau.name',
    descriptionKey: 'connectors.catalog.tableau.description',
  },
  salesforce: {
    key: 'salesforce',
    label: 'Salesforce',
    // Global host; the ORG is resolved from the OAuth token, not the URL.
    // Salesforce publishes several servers under /platform/mcp/v1/<name>;
    // sobject-all is the general-purpose record CRUD surface. Sandboxes live
    // under a /sandbox/ path segment and would need a separate entry.
    // https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/servers-reference.html
    url: 'https://api.salesforce.com/platform/mcp/v1/platform/sobject-all',
    transport: 'streamable-http',
    // Requires an External Client App created in the org (scopes mcp_api +
    // refresh_token) whose consumer key is supplied as the static client —
    // Salesforce has no DCR, so MCP_OAUTH_SALESFORCE_CLIENT_ID is mandatory.
    auth: { style: 'oauth' },
    nameKey: 'connectors.catalog.salesforce.name',
    descriptionKey: 'connectors.catalog.salesforce.description',
  },
  hootsuitePerch: {
    key: 'hootsuitePerch',
    label: 'Hootsuite Perch',
    // Content creation & publishing. https://www.hootsuite.com/integrations/mcp
    url: 'https://mcp.hootsuite.com/perch',
    transport: 'streamable-http',
    auth: { style: 'oauth' },
    nameKey: 'connectors.catalog.hootsuitePerch.name',
    descriptionKey: 'connectors.catalog.hootsuitePerch.description',
  },
  hootsuiteNest: {
    key: 'hootsuiteNest',
    label: 'Hootsuite Nest',
    // Social inbox & customer care. Hootsuite's third server (Lumen) is
    // deliberately omitted: it is hosted on app.talkwalker.com and needs a
    // separate Talkwalker entitlement.
    url: 'https://mcp.hootsuite.com/nest',
    transport: 'streamable-http',
    auth: { style: 'oauth' },
    nameKey: 'connectors.catalog.hootsuiteNest.name',
    descriptionKey: 'connectors.catalog.hootsuiteNest.description',
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
  /**
   * 'builtin' = first-party in-process toolset (no MCP connection is ever
   * opened; the tool loop dispatches to the builtin executor instead).
   * Absent = a normal network-backed MCP server. Only ever set server-side —
   * resolveMcpServers never produces it from client entries.
   */
  provenance?: 'builtin';
  authToken?: string;
  /**
   * Admin-stored OAuth endpoints (connectors only) — used INSTEAD of RFC
   * 9728/8414 discovery for providers that publish no metadata (NetSuite).
   * Server-resolved from the connector record, never client-supplied.
   */
  oauthEndpoints?: {
    authorizationUrl: string;
    tokenUrl: string;
    /** Defaults to tokenUrl when absent. */
    refreshUrl?: string;
  };
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
  /**
   * Resolves an admin-authored connector id to an executable config, or null
   * when the connector is unknown, the feature is off, or THIS USER is not
   * permitted to use it. Injected for the same reason as isAllowedCustomUrl:
   * the access check needs the session, storage, and the agent-access service,
   * none of which belong in this shared module.
   *
   * Omitting it disables connector resolution entirely — which is the correct
   * default, because a caller that has not wired up an access check must not
   * be able to reach a connector URL.
   */
  resolveConnector?: (connectorId: string) => ResolvedMcpServer | null;
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

    if (entry.connectorId !== undefined) {
      // Unknown, feature-disabled, no resolver wired, or access denied — all
      // collapse to "drop it". Never fall through to the custom-URL branch:
      // a denied connector must not become resolvable just because the client
      // also sent a url alongside the connectorId.
      const connector = options.resolveConnector?.(entry.connectorId) ?? null;
      if (!connector) continue;
      seenIds.add(entry.id);
      resolved.push({
        ...connector,
        id: entry.id,
        // Belt-and-braces, mirroring the catalog branch: a 'none'-style
        // connector gets no credential even if a stale client entry has one.
        authToken:
          connector.auth.style === 'none' ? undefined : entry.authToken,
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
