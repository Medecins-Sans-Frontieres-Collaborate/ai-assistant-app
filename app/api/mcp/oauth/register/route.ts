import { NextRequest } from 'next/server';

import {
  McpOauthError,
  getOauthRedirectUri,
  getStaticOauthClient,
  resolveOauthContext,
} from '@/lib/services/mcp/mcpOauthDiscovery';
import { guardedFetch } from '@/lib/services/mcp/mcpUrlGuard';
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
 * POST /api/mcp/oauth/register — dynamic client registration (RFC 7591)
 * against the DISCOVERED registration endpoint. All client metadata is
 * server-built: the redirect URI comes from the configured app origin (never
 * the request Host header), the auth method is 'none' (public client) —
 * nothing registration-shaped is accepted from the browser.
 */

const limiter = RateLimiter.createScoped(10, 1);

const requestSchema = z
  .object({
    server: z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        name: z.string().min(1).max(100),
        catalogKey: z.string().max(64).optional(),
        url: z.string().max(2048).optional(),
      })
      .strict(),
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
    return badRequestResponse(
      'Invalid MCP server config',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  try {
    // Pre-registered app configured for this connector? Use it and skip DCR
    // entirely — required for GitHub (no DCR) and for Asana on deployed
    // origins (its DCR only allows loopback redirect URIs). Only the
    // clientId goes to the browser; the secret stays in env and is injected
    // by the token route.
    const staticClient = getStaticOauthClient(parsed.data.server.catalogKey);
    if (staticClient) {
      return successResponse({ clientId: staticClient.clientId });
    }

    const context = await resolveOauthContext(parsed.data.server);
    if (!context.metadata.registration_endpoint) {
      return errorResponse(
        `"${context.resolved.label}" does not support dynamic client registration. Configure a pre-registered OAuth app (MCP_OAUTH_*_CLIENT_ID) for this deployment.`,
        502,
        undefined,
        'OAUTH_DCR_UNSUPPORTED',
      );
    }

    const { registerClient } =
      await import('@modelcontextprotocol/sdk/client/auth.js');
    const clientInfo = await registerClient(context.authorizationServerUrl, {
      metadata: context.metadata as AuthorizationServerMetadata,
      clientMetadata: {
        client_name: 'MSF AI Assistant',
        redirect_uris: [getOauthRedirectUri()],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      fetchFn: context.resolved.trusted ? undefined : guardedFetch(),
    });

    return successResponse({
      clientId: clientInfo.client_id,
      ...(clientInfo.client_secret
        ? { clientSecret: clientInfo.client_secret }
        : {}),
    });
  } catch (error) {
    if (error instanceof McpOauthError) {
      return errorResponse(error.message, error.status, undefined, error.code);
    }
    // Log the underlying failure server-side (DCR carries no user secrets —
    // the registration request is public-client metadata only). The CLIENT
    // response stays generic: provider errors can quote our request.
    console.error(
      '[mcp/oauth/register] Dynamic client registration failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return errorResponse(
      'Dynamic client registration failed',
      502,
      undefined,
      'OAUTH_REGISTRATION_FAILED',
    );
  }
}
