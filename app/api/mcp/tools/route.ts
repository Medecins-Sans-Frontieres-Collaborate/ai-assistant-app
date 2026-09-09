import { NextRequest } from 'next/server';

import { connectMcp } from '@/lib/services/mcp/McpClientService';
import { createConnectorResolver } from '@/lib/services/mcp/connectorResolution';
import { isHttpsPublicShapedUrl } from '@/lib/services/mcp/mcpUrlGuard';
import {
  getCachedTools,
  setCachedTools,
  toolCacheKey,
} from '@/lib/services/mcp/toolSchemaCache';
import { RateLimiter } from '@/lib/services/shared/RateLimiter';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { resolveMcpServers } from '@/config/mcpCatalog';
import { z } from 'zod';

/**
 * POST /api/mcp/tools — validate an MCP server config and list its tools.
 *
 * Used by the Connectors settings section to verify a connection (and show
 * "N tools available") before saving. POST rather than GET so the auth token
 * rides in the body — tokens must never appear in URLs/access logs.
 *
 * The token is used in-memory for this one request and never persisted;
 * error paths deliberately never echo it (see McpClientService).
 */

// Tighter than the chat limiter: settings-time validation is a rare action.
const limiter = RateLimiter.createScoped(15, 1);

const requestSchema = z
  .object({
    server: z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        name: z.string().min(1).max(100),
        catalogKey: z.string().max(64).optional(),
        connectorId: z.string().max(64).optional(),
        url: z.string().max(2048).optional(),
        authToken: z.string().max(8192).optional(), // OAuth access tokens (JWTs) can exceed 4KB
      })
      .strict(),
    refresh: z.boolean().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }
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
    // Generic message on purpose: Zod issue paths are fine, but we never
    // reflect received values (the body can contain a token).
    return badRequestResponse(
      'Invalid MCP server config',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  const { server, refresh } = parsed.data;

  // A connector is server-resolved like a catalog entry — it is emphatically
  // not a "custom" server and must not be gated by the arbitrary-URL flag.
  const isCustom =
    server.catalogKey === undefined && server.connectorId === undefined;
  if (isCustom && !env.MCP_CUSTOM_SERVERS_ENABLED) {
    return forbiddenResponse(
      'Arbitrary MCP servers are not enabled on this deployment',
    );
  }

  const [resolved] = resolveMcpServers([server], {
    allowCustom: env.MCP_CUSTOM_SERVERS_ENABLED,
    isAllowedCustomUrl: isHttpsPublicShapedUrl,
    resolveConnector: await createConnectorResolver(session),
  });
  if (!resolved) {
    return badRequestResponse(
      'MCP server config was rejected',
      isCustom
        ? 'The URL must be a public https address'
        : server.connectorId !== undefined
          ? // Deliberately not distinguished from "unknown": telling a user
            // which connector ids exist but are barred from them leaks the
            // admin's configuration.
            'Unknown or unavailable connector'
          : 'Unknown catalog entry',
    );
  }

  const cacheKey = toolCacheKey(userId, resolved.url, resolved.authToken);
  if (!refresh) {
    const cached = getCachedTools(cacheKey);
    if (cached) {
      return successResponse({
        serverLabel: resolved.label,
        tools: cached.tools.map(({ name, description }) => ({
          name,
          description,
        })),
        cached: true,
      });
    }
  }

  let connection;
  try {
    connection = await connectMcp(resolved);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'MCP connection failed';
    // Auth failures surface distinctly so the UI can say "check your token".
    const code = /\b(401|403)\b/.test(message)
      ? 'MCP_AUTH_FAILED'
      : 'MCP_UNREACHABLE';
    return errorResponse(message, 502, undefined, code);
  }

  try {
    const tools = await connection.listTools();
    // Also capture initialize `instructions` so a chat right after this
    // listing reuses them from cache (tool loop reads the same entries).
    setCachedTools(cacheKey, {
      tools,
      instructions: connection.getInstructions?.(),
    });
    return successResponse({
      serverLabel: resolved.label,
      tools: tools.map(({ name, description }) => ({ name, description })),
      cached: false,
    });
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : 'Failed to list MCP tools',
      502,
      undefined,
      'MCP_PROTOCOL_ERROR',
    );
  } finally {
    await connection.close();
  }
}
