import { McpServerRequestEntry } from '@/types/mcp';

import {
  assertPublicHost,
  guardedFetch,
  isHttpsPublicShapedUrl,
} from './mcpUrlGuard';

import { env } from '@/config/environment';
import {
  MCP_CATALOG,
  ResolvedMcpServer,
  resolveMcpServers,
} from '@/config/mcpCatalog';

/**
 * Server-side OAuth discovery for MCP connectors — the security chokepoint
 * of the OAuth proxy routes (app/api/mcp/oauth/*).
 *
 * THE OPEN-RELAY INVARIANT: the client NEVER supplies an OAuth endpoint URL.
 * Every endpoint (authorization, token, registration) is derived HERE, by
 * running RFC 9728/8414 discovery against the catalog-resolved (or
 * env-gated + SSRF-guarded custom) MCP server URL — and each discovered
 * endpoint is then re-validated as a public https URL, even for trusted
 * catalog servers: a compromised MCP server publishing metadata that points
 * its token_endpoint at 169.254.169.254 must be rejected. Any drift toward
 * accepting client-supplied endpoints turns the proxy into an SSRF /
 * credential relay — do not add such parameters.
 */

/** Minimal slice of RFC 8414 authorization-server metadata we rely on. */
export interface McpAuthServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

export interface McpOauthContext {
  resolved: ResolvedMcpServer;
  authorizationServerUrl: string;
  metadata: McpAuthServerMetadata;
  /** RFC 9728 resource indicator, when the server publishes one. */
  resource?: string;
}

export class McpOauthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

// Metadata-only discovery cache (no secrets), 5-min TTL — same accepted
// single-replica pattern as toolSchemaCache.
const cache = new Map<
  string,
  { context: McpOauthContext; expiresAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function validateDiscoveredEndpoint(
  label: string,
  url: string | undefined,
): Promise<void> {
  if (url === undefined) return;
  if (!isHttpsPublicShapedUrl(url)) {
    throw new McpOauthError(
      `Discovered ${label} is not a public https URL`,
      502,
      'OAUTH_DISCOVERY_REJECTED',
    );
  }
  await assertPublicHost(url);
}

/**
 * Resolves a client-sent server entry and discovers its OAuth endpoints.
 * Throws McpOauthError with a client-safe message; never echoes tokens.
 */
export async function resolveOauthContext(
  entry: McpServerRequestEntry,
): Promise<McpOauthContext> {
  const isCustom = entry.catalogKey === undefined;
  if (isCustom && !env.MCP_CUSTOM_SERVERS_ENABLED) {
    throw new McpOauthError(
      'Arbitrary MCP servers are not enabled on this deployment',
      403,
      'MCP_CUSTOM_DISABLED',
    );
  }

  const [resolved] = resolveMcpServers(
    // Strip any token — discovery never needs a credential.
    [
      {
        id: entry.id,
        name: entry.name,
        catalogKey: entry.catalogKey,
        url: entry.url,
      },
    ],
    {
      allowCustom: env.MCP_CUSTOM_SERVERS_ENABLED,
      isAllowedCustomUrl: isHttpsPublicShapedUrl,
    },
  );
  if (!resolved) {
    throw new McpOauthError(
      'MCP server config was rejected',
      400,
      'MCP_SERVER_REJECTED',
    );
  }

  const cached = cache.get(resolved.url);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.context, resolved };
  }

  const { discoverOAuthServerInfo } =
    await import('@modelcontextprotocol/sdk/client/auth.js');

  let info;
  try {
    info = await discoverOAuthServerInfo(resolved.url, {
      fetchFn: resolved.trusted ? undefined : guardedFetch(),
    });
  } catch {
    throw new McpOauthError(
      `OAuth discovery failed for "${resolved.label}"`,
      502,
      'OAUTH_DISCOVERY_FAILED',
    );
  }

  const metadata = (info.authorizationServerMetadata ??
    {}) as McpAuthServerMetadata;
  await validateDiscoveredEndpoint(
    'authorization server',
    info.authorizationServerUrl,
  );
  await validateDiscoveredEndpoint('issuer', metadata.issuer);
  await validateDiscoveredEndpoint(
    'authorization_endpoint',
    metadata.authorization_endpoint,
  );
  await validateDiscoveredEndpoint('token_endpoint', metadata.token_endpoint);
  await validateDiscoveredEndpoint(
    'registration_endpoint',
    metadata.registration_endpoint,
  );

  const resourceCandidate = (
    info as { resourceMetadata?: { resource?: string } }
  ).resourceMetadata?.resource;

  const context: McpOauthContext = {
    resolved,
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    resource: resourceCandidate,
  };
  cache.set(resolved.url, { context, expiresAt: Date.now() + CACHE_TTL_MS });
  return context;
}

/**
 * Pre-registered ("static") OAuth apps for curated connectors, configured
 * via env. Needed because neither provider supports web-app DCR: GitHub
 * publishes no registration endpoint, and Asana's DCR only allows LOOPBACK
 * redirect URIs (fine for localhost dev, never for a deployed origin).
 * The client SECRET stays server-side: the register route returns only the
 * clientId to the browser, and the token route injects the secret when it
 * recognizes the static clientId.
 */
export function getStaticOauthClient(
  catalogKey: string | undefined,
): { clientId: string; clientSecret?: string } | null {
  if (catalogKey === 'github' && env.MCP_OAUTH_GITHUB_CLIENT_ID) {
    return {
      clientId: env.MCP_OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_GITHUB_CLIENT_SECRET,
    };
  }
  if (catalogKey === 'asana' && env.MCP_OAUTH_ASANA_CLIENT_ID) {
    return {
      clientId: env.MCP_OAUTH_ASANA_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_ASANA_CLIENT_SECRET,
    };
  }
  return null;
}

/**
 * Which curated connectors have an OAuth app to tie into on THIS deployment.
 *
 * For catalog entries this is exactly "is a static app configured": per
 * getStaticOauthClient above, neither provider offers usable web-app DCR, so
 * without MCP_OAUTH_*_CLIENT_ID a "Connect with {name}" click can only end in
 * OAUTH_DCR_UNSUPPORTED. Surfacing it (booleans only — no ids, no secrets)
 * lets the settings UI hide an affordance that cannot work instead of
 * failing the user after a popup round-trip. Users bringing their OWN app
 * are unaffected; that path doesn't need a deployment app.
 *
 * Arbitrary (non-catalog) servers are deliberately absent: their DCR support
 * is unknown until discovery runs, so their UI keeps offering the attempt.
 */
export function getCatalogOauthAppAvailability(): Record<string, boolean> {
  const availability: Record<string, boolean> = {};
  for (const entry of Object.values(MCP_CATALOG)) {
    if (entry.auth.style !== 'oauth' && !entry.alsoSupportsOauth) continue;
    availability[entry.key] = getStaticOauthClient(entry.key) !== null;
  }
  return availability;
}

/**
 * The registered redirect URI, built from the CONFIGURED app origin — never
 * from the request Host header (host-header injection would poison the
 * registered redirect URI). localePrefix is 'never', so the callback page
 * under app/[locale]/ is reachable without a prefix. NOTE: this must be the
 * origin users actually browse (BroadcastChannel is origin-scoped) AND the
 * redirect URI registered on any static OAuth app.
 */
export function getOauthRedirectUri(): string {
  const origin = env.NEXTAUTH_URL;
  if (!origin) {
    throw new McpOauthError(
      'OAuth connectors require NEXTAUTH_URL to be configured',
      503,
      'OAUTH_ORIGIN_UNCONFIGURED',
    );
  }
  return new URL('/mcp-oauth-callback', origin).toString();
}

/** Test hook. */
export function clearOauthDiscoveryCache(): void {
  cache.clear();
}
