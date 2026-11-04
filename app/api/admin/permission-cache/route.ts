import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  bumpGeneration,
  createAgentAccessBlobStorage,
} from '@/lib/services/agentAccess/accessRulesStore';
import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { getPermissionCache } from '@/lib/services/permissions/PermissionCache';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { z } from 'zod';

const bodySchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('user'),
      userId: z
        .string()
        .trim()
        .regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i)
        .transform((id) => id.toLowerCase()),
    })
    .strict(),
  z.object({ scope: z.literal('all'), confirm: z.literal(true) }).strict(),
]);

/** Returns configured maximum ages to effective global admins; no user permission data is exposed. */
export async function GET() {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user)) return forbiddenResponse();
  return successResponse({
    groupCacheMinutes: env.PERMISSION_GROUP_CACHE_MINUTES,
    sourceCacheMinutes: env.PERMISSION_SOURCE_CACHE_MINUTES,
  });
}

/**
 * Durably invalidates a user or everyone, gated on the effective global-admin
 * identity (view-as demotion applies). Returns 503 on persistence failure, never
 * falsely reports success. Invalidation requires rechecking, not upstream revocation.
 */
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!session.user.mail || !isGlobalAdmin(session.user))
    return forbiddenResponse();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success)
    return badRequestResponse(
      'Choose a user object ID or explicitly confirm invalidation for everyone',
    );
  const userId = parsed.data.scope === 'user' ? parsed.data.userId : undefined;
  const actor = session.user.mail;
  try {
    // Await the sentinel write as well as the membership/source tombstone.
    // A rules write failure must not be advertised as a complete invalidation.
    await bumpGeneration(createAgentAccessBlobStorage());
    const result = await getPermissionCache().invalidate(actor, userId);
    AgentAccessService.getInstance().invalidate(false);
    console.log(
      `[permission-cache-audit] outcome=invalidated scope=${parsed.data.scope} user=${sanitizeForLog(userId ?? '*')} by=${sanitizeForLog(actor)} generation=${result.generation} at=${result.invalidatedAt}`,
    );
    return successResponse({
      ...result,
      scope: parsed.data.scope,
      userId: userId ?? null,
      status: 'invalidated',
      freshVerificationRequired: true,
    });
  } catch (error) {
    console.error(
      `[permission-cache-audit] outcome=failed scope=${parsed.data.scope} user=${sanitizeForLog(userId ?? '*')} by=${sanitizeForLog(actor)} error=${sanitizeForLog(error)}`,
    );
    return errorResponse(
      'Permission cache invalidation could not be confirmed; retry shortly',
      503,
      undefined,
      'PERMISSION_CACHE_UNAVAILABLE',
    );
  }
}
