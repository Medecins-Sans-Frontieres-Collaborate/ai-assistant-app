import { NextRequest } from 'next/server';

import {
  McpOauthError,
  resolveOauthContext,
} from '@/lib/services/mcp/mcpOauthDiscovery';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import {
  badRequestResponse,
  errorResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * POST /api/mcp/oauth/discover — server-side OAuth discovery for an MCP
 * connector. Returns only what the BROWSER needs: the authorization URL
 * origin for the top-level popup navigation (CSP connect-src doesn't apply
 * to navigations) plus capability hints. Token/DCR endpoints stay
 * server-side — see mcpOauthDiscovery.ts for the open-relay invariant.
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
    const context = await resolveOauthContext(parsed.data.server);
    return successResponse({
      serverLabel: context.resolved.label,
      authorizationEndpoint: context.metadata.authorization_endpoint ?? null,
      scopesSupported: context.metadata.scopes_supported ?? [],
      resource: context.resource ?? null,
      registrationSupported: !!context.metadata.registration_endpoint,
    });
  } catch (error) {
    if (error instanceof McpOauthError) {
      return errorResponse(error.message, error.status, undefined, error.code);
    }
    console.error(
      '[mcp/oauth/discover] Discovery failed:',
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return errorResponse(
      'OAuth discovery failed',
      502,
      undefined,
      'OAUTH_DISCOVERY_FAILED',
    );
  }
}
