'use client';

import {
  McpOauthState,
  McpServerConfig,
  useSettingsStore,
} from '@/client/stores/settingsStore';

/**
 * Browser side of MCP OAuth: authorization-code + PKCE, driven from the
 * Connectors UI, with all network legs to the provider (discovery, DCR,
 * token exchange, refresh) proxied through the stateless same-origin
 * /api/mcp/oauth/* routes (the app CSP blocks direct browser calls to
 * third-party auth hosts; the proxy also owns endpoint validation).
 *
 * Privacy invariants:
 * - The PKCE verifier, state, and any client secret live ONLY in this
 *   function's closure for the seconds the popup is open — they are never
 *   written to sessionStorage/localStorage (the flow cannot survive a tab
 *   reload anyway; the awaiting promise dies with the page).
 * - The authorization CODE travels: provider → popup URL → BroadcastChannel
 *   (in-memory) → POST body to our proxy. It is never stored.
 * - Persisted credentials (tokens, own-app secrets) are handled by the
 *   encrypted credential vault (credentialVault.ts), not written in clear
 *   text.
 */

const CHANNEL_NAME = 'mcp-oauth';
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_SKEW_MS = 60_000;

interface OauthEntry {
  id: string;
  name: string;
  catalogKey?: string;
  url?: string;
}

interface CallbackMessage {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
}

async function proxyPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      json?.error ?? `Request failed: ${response.status}`,
    );
    (error as Error & { code?: string }).code = json?.code;
    throw error;
  }
  return json.data as T;
}

function wireEntry(entry: OauthEntry) {
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.catalogKey
      ? { catalogKey: entry.catalogKey }
      : { url: entry.url }),
  };
}

/**
 * Runs the full connect flow. Resolves with the OAuth state to persist on
 * the server config; rejects on denial/timeout/cancel.
 */
export async function connectMcpOauth(
  entry: OauthEntry,
  existingClientId?: string,
  existingClientSecret?: string,
): Promise<McpOauthState> {
  // 1. Discover (proxy) — the browser only needs the authorization URL.
  const discovery = await proxyPost<{
    authorizationEndpoint: string | null;
    scopesSupported: string[];
    resource: string | null;
  }>('/api/mcp/oauth/discover', { server: wireEntry(entry) });
  if (!discovery.authorizationEndpoint) {
    throw new Error('oauth_unsupported');
  }

  // 2. Client registration (proxy) — reuse a previous DCR result if we have
  // one (reconnect path); fall back to fresh registration.
  let clientId = existingClientId;
  let clientSecret = existingClientSecret;
  if (!clientId) {
    try {
      const registration = await proxyPost<{
        clientId: string;
        clientSecret?: string;
      }>('/api/mcp/oauth/register', { server: wireEntry(entry) });
      clientId = registration.clientId;
      clientSecret = registration.clientSecret;
    } catch (error) {
      // Provider supports neither DCR nor has a pre-registered app on this
      // deployment — a distinct, actionable failure ("use a token instead").
      if ((error as { code?: string }).code === 'OAUTH_DCR_UNSUPPORTED') {
        throw new Error('oauth_unavailable');
      }
      throw error;
    }
  }

  // 3. PKCE + authorization URL — local computation only (WebCrypto).
  const { startAuthorization } =
    await import('@modelcontextprotocol/sdk/client/auth.js');
  const state = globalThis.crypto.randomUUID();
  const redirectUrl = `${window.location.origin}/mcp-oauth-callback`;
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    discovery.authorizationEndpoint,
    {
      // Minimal metadata so the SDK uses the (server-discovered) endpoint
      // VERBATIM — without metadata it would append '/authorize' to the URL.
      metadata: {
        authorization_endpoint: discovery.authorizationEndpoint,
        response_types_supported: ['code'],
      } as never,
      clientInformation: {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      },
      redirectUrl,
      state,
      ...(discovery.resource ? { resource: new URL(discovery.resource) } : {}),
    },
  );

  // 4. Popup + BroadcastChannel. The PKCE verifier (and client secret) stay
  // in THIS closure — deliberately not stashed in any web storage: the flow
  // resolves in this same tab, and secrets must never sit on disk, however
  // briefly (flagged by code scanning as clear-text storage).
  // BroadcastChannel over postMessage: it is
  // same-origin by construction (no origin-check foot-gun) and survives a
  // severed window.opener; over localStorage events: those would write the
  // authorization code into localStorage, exactly what we're avoiding.
  const popup = window.open(
    authorizationUrl.toString(),
    'mcp-oauth',
    'popup,width=600,height=750',
  );

  const message = await new Promise<CallbackMessage>((resolve, reject) => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    const cleanup = () => {
      channel.close();
      clearTimeout(timeout);
      clearInterval(closedPoll);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('oauth_timeout'));
    }, FLOW_TIMEOUT_MS);
    // Popup closed without completing = user cancelled.
    const closedPoll = setInterval(() => {
      if (popup && popup.closed) {
        // Give a just-posted message a beat to arrive before cancelling.
        setTimeout(() => {
          cleanup();
          reject(new Error('oauth_cancelled'));
        }, 1500);
        clearInterval(closedPoll);
      }
    }, 1000);
    channel.onmessage = (event: MessageEvent<CallbackMessage>) => {
      if (event.data?.state !== state) return;
      cleanup();
      resolve(event.data);
    };
  });

  if (message.error || !message.code) {
    throw new Error(
      message.error === 'access_denied' ? 'oauth_denied' : 'oauth_failed',
    );
  }

  // 6. Exchange via proxy.
  const { tokens } = await proxyPost<{
    tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
  }>('/api/mcp/oauth/token', {
    server: wireEntry(entry),
    grant: {
      type: 'authorization_code',
      code: message.code,
      codeVerifier,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
    },
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined,
    scope: tokens.scope,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    needsReauth: false,
  };
}

// Single-flight refresh guard: parallel sends must not double-refresh (a
// rotated refresh token would invalidate its sibling's copy).
const refreshInFlight = new Map<string, Promise<string | undefined>>();

/**
 * Returns a live access token for an oauth-mode server, refreshing through
 * the proxy when close to expiry. Returns undefined when there is no usable
 * token (needsReauth) — the caller must then EXCLUDE the server from the
 * request. Updates the settings store with rotated tokens / reauth flags.
 */
export async function ensureFreshOauthToken(
  server: McpServerConfig,
): Promise<string | undefined> {
  const oauth = server.oauth;
  if (!oauth?.accessToken || oauth.needsReauth) return undefined;

  const isFresh =
    oauth.expiresAt === undefined ||
    oauth.expiresAt - Date.now() > REFRESH_SKEW_MS;
  if (isFresh) return oauth.accessToken;
  if (!oauth.refreshToken) {
    // Expired with no refresh token: force reauth.
    useSettingsStore.getState().updateMcpServer(server.id, {
      oauth: { ...oauth, accessToken: undefined, needsReauth: true },
    });
    return undefined;
  }

  const inFlight = refreshInFlight.get(server.id);
  if (inFlight) return inFlight;

  const refreshPromise = (async (): Promise<string | undefined> => {
    try {
      const { tokens } = await proxyPost<{
        tokens: {
          access_token: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
        };
      }>('/api/mcp/oauth/token', {
        server: wireEntry({
          id: server.id,
          name: server.name,
          catalogKey: server.catalogKey,
          url: server.url || undefined,
        }),
        grant: {
          type: 'refresh_token',
          refreshToken: oauth.refreshToken,
          clientId: oauth.clientId,
          ...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
        },
      });
      const next: McpOauthState = {
        ...oauth,
        accessToken: tokens.access_token,
        // Refresh-token rotation: always adopt a newly issued one.
        refreshToken: tokens.refresh_token ?? oauth.refreshToken,
        expiresAt: tokens.expires_in
          ? Date.now() + tokens.expires_in * 1000
          : undefined,
        scope: tokens.scope ?? oauth.scope,
        needsReauth: false,
      };
      useSettingsStore.getState().updateMcpServer(server.id, { oauth: next });
      return next.accessToken;
    } catch {
      // invalid_grant or anything else: wipe tokens, keep the DCR clientId
      // (reconnect reuses it), surface "Reconnect" in Connectors.
      useSettingsStore.getState().updateMcpServer(server.id, {
        oauth: {
          clientId: oauth.clientId,
          ...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
          needsReauth: true,
        },
      });
      return undefined;
    } finally {
      refreshInFlight.delete(server.id);
    }
  })();

  refreshInFlight.set(server.id, refreshPromise);
  return refreshPromise;
}
