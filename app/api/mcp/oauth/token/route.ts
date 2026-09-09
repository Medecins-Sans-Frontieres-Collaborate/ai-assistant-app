import { NextRequest } from 'next/server';

import { createConnectorResolver } from '@/lib/services/mcp/connectorResolution';
import {
  McpOauthError,
  getOauthClientCredentials,
  getOauthRedirectUri,
  resolveOauthContext,
} from '@/lib/services/mcp/mcpOauthDiscovery';
import { guardedFetch } from '@/lib/services/mcp/mcpUrlGuard';
import { withOauthErrorNormalization } from '@/lib/services/mcp/oauthResponseNormalization';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import {
  badRequestResponse,
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import type { AuthorizationServerMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

/**
 * POST /api/mcp/oauth/token — authorization-code exchange and refresh, run
 * against the DISCOVERED token endpoint. Secrets (code, verifier, refresh
 * token) ride only in this POST body, are used in-memory, never logged, and
 * never persisted — the resulting tokens go back to the browser, which is
 * their only durable home (localStorage, like every other credential here).
 *
 * The proxy forwards ONLY the whitelisted grant fields below; it cannot be
 * steered at any endpoint the server didn't discover itself.
 */

const limiter = RateLimiter.createScoped(10, 1);

const serverSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    name: z.string().min(1).max(100),
    catalogKey: z.string().max(64).optional(),
    connectorId: z.string().max(64).optional(),
    url: z.string().max(2048).optional(),
  })
  .strict();

const requestSchema = z
  .object({
    server: serverSchema,
    grant: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('authorization_code'),
          code: z.string().min(1).max(4096),
          codeVerifier: z.string().min(1).max(256),
          clientId: z.string().min(1).max(512),
          clientSecret: z.string().max(1024).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('refresh_token'),
          refreshToken: z.string().min(1).max(8192),
          clientId: z.string().min(1).max(512),
          clientSecret: z.string().max(1024).optional(),
        })
        .strict(),
    ]),
  })
  .strict();

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  const userId = session.user.id ?? session.user.mail ?? 'unknown';
  if (!limiter.checkLimit(userId).allowed) {
    return errorResponse('Too many requests', 429, undefined, 'RATE_LIMITED');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    // Paths only — the body carries codes/tokens that must never reflect.
    return badRequestResponse(
      'Invalid OAuth token request',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  const { server, grant } = parsed.data;

  try {
    const context = await resolveOauthContext(server, {
      resolveConnector: await createConnectorResolver(session),
    });
    const metadata = context.metadata as AuthorizationServerMetadata;
    // Always wrapped: GitHub reports token failures as 200-with-error-body,
    // which the SDK would otherwise mangle into an opaque ZodError.
    const fetchFn = withOauthErrorNormalization(
      context.resolved.trusted ? undefined : guardedFetch(),
    );
    // Static (pre-registered) clients: the browser only ever holds the
    // clientId — the SECRET lives in env and is injected here, server-side.
    // Any browser-sent secret is ignored for a recognized static clientId.
    const staticClient = await getOauthClientCredentials(server);
    const clientInformation =
      staticClient && grant.clientId === staticClient.clientId
        ? {
            client_id: staticClient.clientId,
            ...(staticClient.clientSecret
              ? { client_secret: staticClient.clientSecret }
              : {}),
          }
        : {
            client_id: grant.clientId,
            ...(grant.clientSecret
              ? { client_secret: grant.clientSecret }
              : {}),
          };

    const { exchangeAuthorization, refreshAuthorization } =
      await import('@modelcontextprotocol/sdk/client/auth.js');

    const tokens =
      grant.type === 'authorization_code'
        ? await exchangeAuthorization(context.authorizationServerUrl, {
            metadata,
            clientInformation,
            authorizationCode: grant.code,
            codeVerifier: grant.codeVerifier,
            redirectUri: getOauthRedirectUri(),
            ...(context.resource
              ? { resource: new URL(context.resource) }
              : {}),
            fetchFn,
          })
        : await refreshAuthorization(context.authorizationServerUrl, {
            // A connector may store a refresh URL distinct from its token URL
            // (Azure-style templates expose all three); the SDK only knows
            // token_endpoint, so substitute it for the refresh grant.
            metadata: context.refreshTokenEndpoint
              ? ({
                  ...metadata,
                  token_endpoint: context.refreshTokenEndpoint,
                } as AuthorizationServerMetadata)
              : metadata,
            clientInformation,
            refreshToken: grant.refreshToken,
            ...(context.resource
              ? { resource: new URL(context.resource) }
              : {}),
            fetchFn,
          });

    // OAuthTokens pass-through: access_token, token_type, expires_in?,
    // refresh_token?, scope?.
    return successResponse({ tokens });
  } catch (error) {
    if (error instanceof McpOauthError) {
      return errorResponse(error.message, error.status, undefined, error.code);
    }
    const message = error instanceof Error ? error.message : '';
    // Log the failure class server-side. Provider error MESSAGES are safe
    // (our secrets ride in the request, not the response) but grant values
    // must never be interpolated here.
    console.error(
      `[mcp/oauth/token] ${grant.type} failed:`,
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    // invalid_grant gets a stable code so the client wipes tokens + reauths.
    // bad_verification_code is GitHub's spelling of the same condition; its
    // description text is matched too because the SDK surfaces unknown error
    // codes as their description only ("The code passed is incorrect or
    // expired.").
    if (
      /invalid_grant|bad_verification_code|code passed is incorrect or expired/i.test(
        message,
      )
    ) {
      return errorResponse(
        'The authorization is no longer valid',
        400,
        undefined,
        'OAUTH_INVALID_GRANT',
      );
    }
    return errorResponse(
      grant.type === 'authorization_code'
        ? 'Token exchange failed'
        : 'Token refresh failed',
      502,
      undefined,
      'OAUTH_TOKEN_FAILED',
    );
  }
}
