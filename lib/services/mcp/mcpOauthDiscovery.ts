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
 *
 * The one non-discovery source of endpoints is an admin-authored connector
 * record (resolved.oauthEndpoints): ADMIN-stored, write-time validated, and
 * resolved server-side through the same access-checked path as the connector
 * URL itself — never taken from the request. Needed for providers that
 * publish no discovery metadata at all (NetSuite's endpoints are
 * per-account). Those endpoints are re-validated here too.
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
  /**
   * Distinct refresh endpoint, only for connectors that store one. The token
   * route substitutes it for metadata.token_endpoint on refresh_token grants;
   * absent means refresh uses the token endpoint (the OAuth 2.0 norm).
   */
  refreshTokenEndpoint?: string;
}

export interface ResolveOauthContextOptions {
  /**
   * Access-checked connector resolver (see createConnectorResolver). Required
   * for any entry carrying a connectorId — without it the entry resolves to
   * nothing and discovery fails closed, which is the correct default for a
   * route that has not established who is asking.
   */
  resolveConnector?: (connectorId: string) => ResolvedMcpServer | null;
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
  options: ResolveOauthContextOptions = {},
): Promise<McpOauthContext> {
  // A connector is server-resolved like a catalog entry, so it is not
  // "custom" and must not be gated by the arbitrary-URL flag.
  const isCustom =
    entry.catalogKey === undefined && entry.connectorId === undefined;
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
        connectorId: entry.connectorId,
        url: entry.url,
      },
    ],
    {
      allowCustom: env.MCP_CUSTOM_SERVERS_ENABLED,
      isAllowedCustomUrl: isHttpsPublicShapedUrl,
      // Absent resolver → connectors resolve to nothing, so an OAuth route
      // that forgets to pass one cannot start a flow against a connector.
      resolveConnector: options.resolveConnector,
    },
  );
  if (!resolved) {
    throw new McpOauthError(
      'MCP server config was rejected',
      400,
      'MCP_SERVER_REJECTED',
    );
  }

  // Admin-stored endpoints replace discovery outright: providers that need
  // them publish no metadata to discover, and mixing the two sources would
  // make it ambiguous which one is authoritative. No cache involvement —
  // building this context is pure, and caching would serve a 5-min-stale
  // copy of endpoints an admin may have just corrected.
  if (resolved.oauthEndpoints) {
    const { authorizationUrl, tokenUrl, refreshUrl } = resolved.oauthEndpoints;
    // Same bar as discovered endpoints: write-time validation protects the
    // stored record, this protects the request path even if a blob was
    // hand-edited underneath the admin API.
    await validateDiscoveredEndpoint(
      'authorization_endpoint',
      authorizationUrl,
    );
    await validateDiscoveredEndpoint('token_endpoint', tokenUrl);
    await validateDiscoveredEndpoint('refresh token_endpoint', refreshUrl);
    return {
      resolved,
      // Fallback base only — the SDK uses metadata.token_endpoint verbatim
      // whenever it is set, which it always is here.
      authorizationServerUrl: new URL(tokenUrl).origin,
      metadata: {
        authorization_endpoint: authorizationUrl,
        token_endpoint: tokenUrl,
      },
      ...(refreshUrl && refreshUrl !== tokenUrl
        ? { refreshTokenEndpoint: refreshUrl }
        : {}),
    };
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
 * via env. Needed because usable web-app DCR is the exception, not the rule,
 * across these providers: GitHub publishes no registration endpoint, Asana's
 * DCR only allows LOOPBACK redirect URIs (fine for localhost dev, never for a
 * deployed origin), and Salesforce and Hootsuite require an app registered in
 * the vendor console. Tableau (OAuth 2.1) may register dynamically, so its
 * entry here is a fallback rather than a precondition — returning null simply
 * lets the DCR path run.
 * The client SECRET stays server-side: the register route returns only the
 * clientId to the browser, and the token route injects the secret when it
 * recognizes the static clientId.
 */
export function getStaticOauthClient(
  catalogKey: string | undefined,
): { clientId: string; clientSecret?: string } | null {
  if (catalogKey === undefined) return null;
  // Both Hootsuite servers share one OAuth app — the account, not the
  // server, is what the user authorizes.
  const credentials: Record<
    string,
    { clientId?: string; clientSecret?: string }
  > = {
    github: {
      clientId: env.MCP_OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_GITHUB_CLIENT_SECRET,
    },
    asana: {
      clientId: env.MCP_OAUTH_ASANA_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_ASANA_CLIENT_SECRET,
    },
    tableau: {
      clientId: env.MCP_OAUTH_TABLEAU_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_TABLEAU_CLIENT_SECRET,
    },
    salesforce: {
      clientId: env.MCP_OAUTH_SALESFORCE_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_SALESFORCE_CLIENT_SECRET,
    },
    hootsuitePerch: {
      clientId: env.MCP_OAUTH_HOOTSUITE_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_HOOTSUITE_CLIENT_SECRET,
    },
    hootsuiteNest: {
      clientId: env.MCP_OAUTH_HOOTSUITE_CLIENT_ID,
      clientSecret: env.MCP_OAUTH_HOOTSUITE_CLIENT_SECRET,
    },
  };

  const entry = credentials[catalogKey];
  if (!entry?.clientId) return null;
  return { clientId: entry.clientId, clientSecret: entry.clientSecret };
}

/**
 * The OAuth client to authenticate as, for EITHER kind of server-resolved
 * entry: a curated catalog key (app configured via env) or an admin-authored
 * connector (app stored on the connector record, secret sealed at rest).
 *
 * Returns null when no app is configured, which lets the caller fall back to
 * dynamic client registration.
 *
 * Callers MUST have resolved the entry through an access-checked path first
 * (resolveOauthContext with a resolveConnector). This function deliberately
 * does not re-authorize: it is reached only after resolution succeeded, and
 * duplicating the check here would invite the two copies to drift apart.
 *
 * A connector whose sealed secret cannot be unsealed — the expected shape of
 * an AUTH_SECRET rotation — surfaces as a distinct error rather than a silent
 * fallback to DCR, because falling back would authenticate as the wrong
 * client and fail confusingly at the vendor instead of here.
 */
export async function getOauthClientCredentials(
  entry: Pick<McpServerRequestEntry, 'catalogKey' | 'connectorId'>,
): Promise<{ clientId: string; clientSecret?: string } | null> {
  if (entry.connectorId === undefined) {
    return getStaticOauthClient(entry.catalogKey);
  }

  const { AgentAccessService } =
    await import('@/lib/services/agentAccess/AgentAccessService');
  const service = AgentAccessService.getInstance();
  await service.ensureFresh();
  const connector = service.getConnectorById(entry.connectorId);
  if (!connector?.oauthClientId) return null;

  if (!connector.oauthClientSecret) {
    // A public client: the connector was configured with an id but no secret.
    return { clientId: connector.oauthClientId };
  }

  const { ConnectorSecretIntegrityError, unsealConnectorSecret } =
    await import('@/lib/services/agentAccess/connectorSecretCrypto');
  try {
    return {
      clientId: connector.oauthClientId,
      clientSecret: unsealConnectorSecret(
        connector.id,
        connector.oauthClientSecret,
      ),
    };
  } catch (error) {
    if (error instanceof ConnectorSecretIntegrityError) {
      throw new McpOauthError(
        'This connector’s stored client secret could not be read; an administrator must re-enter it',
        503,
        'CONNECTOR_SECRET_UNREADABLE',
      );
    }
    throw error;
  }
}

/**
 * Which curated connectors have an OAuth app to tie into on THIS deployment.
 *
 * For most catalog entries this is exactly "is a static app configured": per
 * getStaticOauthClient above, they offer no usable web-app DCR, so without
 * MCP_OAUTH_*_CLIENT_ID a "Connect with {name}" click can only end in
 * OAUTH_DCR_UNSUPPORTED. Entries flagged supportsDynamicRegistration are the
 * exception — they can register a client mid-flow, so the affordance stays
 * available with no deployment app. Surfacing this (booleans only — no ids,
 * no secrets)
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
    availability[entry.key] =
      entry.supportsDynamicRegistration === true ||
      getStaticOauthClient(entry.key) !== null;
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
