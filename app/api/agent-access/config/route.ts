import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  readConfig,
  writeConfig,
} from '@/lib/services/agentAccess/accessRulesStore';
import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';
import { AgentAccessConfig } from '@/lib/services/agentAccess/types';

import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  handleApiError,
  notFoundResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';
import { z } from 'zod';

/**
 * GET/PUT /api/agent-access/config — the local-admin delegation map
 * (config.json). GLOBAL admins only: this file decides who else may edit
 * rules, so local admins must never be able to touch it. 404 while the
 * feature is disabled. Same CAS pattern as the rules route (If-Match update /
 * absent If-Match create-only, 412 → 409). GET reads storage directly (not
 * the ≤60s-stale service snapshot) so the echoed ETag is current for editing.
 */

// Only an exact quoted strong ETag may reach the storage CAS condition —
// `If-Match: *` matches any blob and would reduce the CAS to a blind write,
// and a weak validator (W/…) can never strong-match.
const STRONG_ETAG_REGEX = /^"[^"]*"$/;

/**
 * WRITE-side schema only — deliberately stricter than the shared
 * LocalAdminEntrySchema in types.ts (which must keep accepting every
 * already-persisted config blob): size caps bound admin-supplied payloads.
 */
const putBodySchema = z.object({
  localAdmins: z
    .array(
      z.object({
        email: z.string().min(1).max(320),
        agentKeys: z.array(z.string().max(1300)).max(500).default([]),
      }),
    )
    .max(500)
    .default([]),
});

export async function GET() {
  // Feature flag BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  if (!isGlobalAdmin(session.user)) return forbiddenResponse();

  try {
    const result = await readConfig(createAgentAccessBlobStorage());
    if (result === null) {
      return successResponse({ config: null, etag: null });
    }
    return successResponse({ config: result.config, etag: result.etag });
  } catch (error) {
    return handleApiError(error, 'Failed to read agent access config');
  }
}

export async function PUT(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail || !isGlobalAdmin(session.user)) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid config body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const config: AgentAccessConfig = {
    version: 1,
    // Delegated keys are compared canonicalized everywhere (canonicalAgentKey
    // = trim + lowercase) — persist them canonical so the stored config is
    // exactly what enforcement matches on.
    localAdmins: parsed.data.localAdmins.map((admin) => ({
      ...admin,
      agentKeys: admin.agentKeys.map((key) => key.trim().toLowerCase()),
    })),
    updatedBy: userMail,
    updatedAt: new Date().toISOString(),
  };

  try {
    const etag = await writeConfig(
      createAgentAccessBlobStorage(),
      config,
      ifMatchEtag,
    );
    service.invalidate();
    console.log(
      `[agent-access-admin] action=config-write localAdmins=${config.localAdmins.length} by=${sanitizeForLog(userMail)}`,
    );
    return successResponse({ etag });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      // Another replica just won the CAS — refresh this replica's
      // enforcement state promptly instead of serving it stale for ≤60s.
      service.invalidate();
      return errorResponse(
        'Config was modified by another admin; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to write agent access config');
  }
}
