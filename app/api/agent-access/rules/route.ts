import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  StoredAgentAccessRule,
  createAgentAccessBlobStorage,
  deleteRule,
  listAllRules,
  readConfig,
  writeHistoryEntry,
  writeRule,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  AdminStatus,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  AgentAccessConfig,
  AgentAccessHistoryEntry,
  AgentAccessRule,
  AgentAccessTypeSchema,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

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
 * GET/PUT/DELETE /api/agent-access/rules — admin CRUD for per-agent access
 * rules (docs/AGENT_ACCESS_CONTROL.md, "API surface"). 404 while the feature
 * is disabled. Authorization is per canonical key: global admins may touch
 * any key; local admins only the keys delegated to them in config.json.
 *
 * Writes are compare-and-swap (backup-manifest pattern): `If-Match: <etag>`
 * for updates, absent If-Match → create-only (`If-None-Match: *` in the
 * store). Azure 412 → 409 AGENT_ACCESS_CONFLICT. Every successful mutation
 * appends an immutable history blob and invalidates this replica's rules
 * cache.
 */

// Only an exact quoted strong ETag may reach the storage CAS condition —
// `If-Match: *` matches any blob and would reduce the CAS to a blind write,
// and a weak validator (W/…) can never strong-match.
const STRONG_ETAG_REGEX = /^"[^"]*"$/;

/**
 * WRITE-side schema only — deliberately stricter than the shared read schema
 * in types.ts (which must keep accepting every already-persisted blob):
 * `.trim().min(1)` rejects whitespace-only source/agentName (whose canonical
 * key would collapse to an empty string, minting an undeletable rule that
 * also matches every unresolved-source invocation of that agent name) and
 * transforms stored values clean; size caps bound admin-supplied payloads.
 */
const putBodySchema = z.object({
  source: z.string().trim().min(1).max(1024),
  agentName: z.string().trim().min(1).max(256),
  access: z.object({
    type: AgentAccessTypeSchema,
    allowDomains: z.array(z.string().max(255)).max(500).default([]),
    allowUsers: z.array(z.string().max(320)).max(2000).default([]),
    allowGroups: z.array(z.string().max(320)).max(500).default([]),
  }),
});

/** May this admin write the given canonical key? Keys are compared canonicalized. */
function canEditKey(status: AdminStatus, canonicalKey: string): boolean {
  if (status.editableAgentKeys === ALL_AGENT_KEYS) return true;
  return status.editableAgentKeys.some(
    (key) => key.trim().toLowerCase() === canonicalKey,
  );
}

function auditAdminWrite(
  action: 'upsert' | 'delete',
  canonicalKey: string,
  updatedBy: string,
): void {
  console.log(
    `[agent-access-admin] action=${action} key=${sanitizeForLog(canonicalKey)} by=${sanitizeForLog(updatedBy)}`,
  );
}

/**
 * History is the durable audit trail but blob storage has no transactions:
 * by the time the entry is written the rule mutation has already landed, so
 * a history failure must not convert a successful save into a client-visible
 * error (a retry with the same If-Match would then 409). Log loudly instead.
 */
async function appendHistoryBestEffort(
  entry: AgentAccessHistoryEntry,
): Promise<void> {
  try {
    await writeHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

export async function GET() {
  // Feature flag BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  try {
    // Read storage DIRECTLY (like config GET), not the ≤60s-stale service
    // snapshot: the etags echoed here feed the If-Match CAS, so after a 409
    // the UI's reload must observe the other replica's write immediately —
    // a snapshot-served stale etag would 409 again in a loop.
    let rules: StoredAgentAccessRule[] = [];
    let config: AgentAccessConfig | null = null;
    let rulesUnavailable = false;
    let fetchedAt: number | null = null;
    try {
      const storage = createAgentAccessBlobStorage();
      const [listedRules, configResult] = await Promise.all([
        listAllRules(storage),
        readConfig(storage),
      ]);
      rules = listedRules;
      config = configResult?.config ?? null;
      fetchedAt = Date.now();
    } catch (error) {
      // Same contract as the snapshot path: storage outage → empty listing
      // flagged rulesUnavailable, not a 500.
      console.error(
        `[agent-access-admin] direct rules read failed: ${sanitizeForLog(error)}`,
      );
      rulesUnavailable = true;
    }

    const status = resolveAdminStatus(session.user, config);
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }

    const visible =
      status.editableAgentKeys === ALL_AGENT_KEYS
        ? rules
        : rules.filter((stored) => canEditKey(status, stored.canonicalKey));

    return successResponse({
      rules: visible.map((stored) => ({
        canonicalKey: stored.canonicalKey,
        rule: stored.rule,
        etag: stored.etag,
      })),
      rulesUnavailable,
      fetchedAt,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list agent access rules');
  }
}

export async function PUT(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  // No Graph mail → cannot be an admin (both admin registries are keyed on
  // mail), and updatedBy would be unattributable.
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid rule body',
      parsed.error.issues.map((i) => i.path.join('.')).join(', '),
    );
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(
    parsed.data.source,
    parsed.data.agentName,
  );

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this agent key');
    }

    const rule: AgentAccessRule = {
      version: 1,
      source: parsed.data.source,
      agentName: parsed.data.agentName,
      access: parsed.data.access,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    };

    // writeRule derives the blob path from the rule's own source+agentName,
    // so the authorized canonicalKey is exactly the key being written.
    const etag = await writeRule(
      createAgentAccessBlobStorage(),
      rule,
      ifMatchEtag,
    );
    service.invalidate();
    auditAdminWrite('upsert', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      rule,
      updatedBy: userMail,
      updatedAt: rule.updatedAt,
    });

    return successResponse({ canonicalKey, etag });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      // Another replica just won the CAS — refresh this replica's
      // enforcement state promptly instead of serving it stale for ≤60s.
      service.invalidate();
      return errorResponse(
        'Rule was modified by another admin; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to write agent access rule');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return forbiddenResponse();

  const source = request.nextUrl.searchParams.get('source');
  const agentName = request.nextUrl.searchParams.get('agentName');
  if (!source?.trim() || !agentName?.trim()) {
    return badRequestResponse('source and agentName query params are required');
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const canonicalKey = canonicalAgentKey(source, agentName);

  try {
    await service.ensureFresh();
    const status = resolveAdminStatus(
      session.user,
      service.getSnapshot().config,
    );
    if (!status.isGlobalAdmin && !status.isLocalAdmin) {
      return forbiddenResponse();
    }
    if (!canEditKey(status, canonicalKey)) {
      return forbiddenResponse('Not authorized for this agent key');
    }

    const deleted = await deleteRule(
      createAgentAccessBlobStorage(),
      canonicalKey,
      ifMatchEtag,
    );
    if (!deleted) {
      return notFoundResponse('Rule');
    }
    service.invalidate();
    auditAdminWrite('delete', canonicalKey, userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      rule: null,
      updatedBy: userMail,
      updatedAt: new Date().toISOString(),
    });

    return successResponse({ canonicalKey, deleted: true });
  } catch (error) {
    if (error instanceof AgentAccessConflictError) {
      // Another replica just won the CAS — refresh this replica's
      // enforcement state promptly instead of serving it stale for ≤60s.
      service.invalidate();
      return errorResponse(
        'Rule was modified by another admin; reload and retry',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to delete agent access rule');
  }
}
