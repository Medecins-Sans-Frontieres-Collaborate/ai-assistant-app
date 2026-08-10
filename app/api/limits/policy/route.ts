import { NextRequest } from 'next/server';

import { isGlobalAdmin } from '@/lib/services/agentAccess/adminAuth';

/**
 * GET/PUT /api/limits/policy — the org-wide usage-limits policy.
 *
 * GLOBAL admins only (the AGENT_ACCESS_ADMINS roster). Unlike agent access
 * rules there is no per-key delegation: a limits policy is a single org-wide
 * document, so a local admin has no meaningful subset to own.
 *
 * 404 while the feature is disabled. CAS: If-Match update / absent If-Match
 * create-only, 412 → 409. GET reads storage DIRECTLY rather than the ≤60s
 * stale service snapshot, so the echoed ETag is current for editing.
 */
// Only an exact quoted strong ETag may reach a storage CAS condition — see
// STRONG_ETAG_REGEX in adminRouteHelpers for the full rationale.
import { STRONG_ETAG_REGEX } from '@/lib/services/agentAccess/adminRouteHelpers';
import { LimitsService } from '@/lib/services/limits/LimitsService';
import {
  LimitsConflictError,
  createLimitsBlobStorage,
  readPolicy,
  writeHistoryEntry,
  writePolicy,
} from '@/lib/services/limits/limitsStore';
import { LimitsPolicy } from '@/lib/services/limits/types';

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
import { DIMENSION_RE, LIMIT_KEYS, getLimitDefinition } from '@/config/limits';
import { z } from 'zod';

/** Bounds the single-document design: ~1MB worst case, KBs realistically. */
const MAX_OVERRIDES = 200;
const MAX_ENTRIES_PER_OVERRIDE = 50;
const MAX_TARGETS_PER_OVERRIDE = 500;

const dimension = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => DIMENSION_RE.test(v.toLowerCase()), {
    message: 'Invalid model/series qualifier',
  });

/**
 * WRITE-side schema — deliberately stricter than the permissive read schema
 * in types.ts (which must keep parsing every already-stored blob).
 *
 * Model/series qualifiers are validated by SHAPE ONLY, never against the live
 * model catalog: ids come from always-on Foundry discovery and vary per ring,
 * so a limit pinned to a model absent from THIS ring must still persist.
 */
const entrySchema = z
  .object({
    limitKey: z.string().refine((k) => LIMIT_KEYS.has(k), {
      message: 'Unknown limit key',
    }),
    modelId: dimension.optional(),
    series: dimension.optional(),
    value: z.union([
      z.number().int().nonnegative().max(1_000_000_000),
      z.null(),
      z.boolean(),
    ]),
    ceiling: z.boolean().default(false),
  })
  .refine((e) => !(e.modelId && e.series), {
    message: 'An entry may carry at most one of modelId / series',
  })
  .refine((e) => !e.modelId || getLimitDefinition(e.limitKey)?.perModel, {
    message: 'This limit cannot be qualified by a model',
  })
  .refine((e) => !e.series || getLimitDefinition(e.limitKey)?.perModel, {
    message: 'This limit cannot be qualified by a series',
  });

const overrideSchema = z.object({
  id: z.string().regex(/^lim-[0-9a-f]{12}$/),
  label: z.string().max(200).default(''),
  enabled: z.boolean().default(true),
  scope: z.enum(['user', 'domain', 'attribute', 'group']),
  targets: z.array(z.string().min(1).max(320)).max(MAX_TARGETS_PER_OVERRIDE),
  priority: z.number().int().min(-1000).max(1000).default(0),
  entries: z.array(entrySchema).max(MAX_ENTRIES_PER_OVERRIDE),
});

const putBodySchema = z.object({
  defaults: z.array(entrySchema).max(500).default([]),
  overrides: z.array(overrideSchema).max(MAX_OVERRIDES).default([]),
  mode: z.enum(['observe', 'enforce']).default('observe'),
  failMode: z.enum(['open', 'closed']).default('open'),
  timezone: z.string().min(1).max(64).default('UTC'),
  countByomUsage: z.boolean().default(false),
  countAuxiliaryUsage: z.boolean().default(false),
});

/**
 * Clamps every entry to its compiled hardCeiling at the WRITE boundary, so a
 * stored policy can never claim a value the resolver would silently reduce —
 * an admin must see the number that will actually apply.
 */
function clampToHardCeilings(
  entries: z.infer<typeof entrySchema>[],
): z.infer<typeof entrySchema>[] {
  return entries.map((entry) => {
    const def = getLimitDefinition(entry.limitKey);
    if (
      def?.hardCeiling !== undefined &&
      typeof entry.value === 'number' &&
      entry.value > def.hardCeiling
    ) {
      return { ...entry, value: def.hardCeiling };
    }
    return entry;
  });
}

/** Rejects an unresolvable timezone rather than storing a silent UTC fallback. */
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  // Feature gate BEFORE auth: a disabled deployment must answer 404 to
  // everyone, exactly like a route that does not exist.
  if (!LimitsService.getInstance().isEnabled())
    return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();
  if (!isGlobalAdmin(session.user.mail)) return forbiddenResponse();

  try {
    const result = await readPolicy(createLimitsBlobStorage());
    return successResponse({
      policy: result?.policy ?? null,
      etag: result?.etag ?? null,
      policyUnavailable: false,
    });
  } catch (error) {
    // ⚠ Never answer "no policy configured" on a read failure: that would
    // tell an admin everything is unlimited while enforcement does something
    // else entirely. The client renders an error + Retry, never an empty form.
    console.error(
      `[limits-admin] policy read failed: ${sanitizeForLog(error)}`,
    );
    return successResponse({
      policy: null,
      etag: null,
      policyUnavailable: true,
    });
  }
}

export async function PUT(request: NextRequest) {
  const service = LimitsService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');

  const session = await auth();
  if (!session?.user) return unauthorizedResponse();

  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail || !isGlobalAdmin(userMail)) return forbiddenResponse();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequestResponse('Invalid JSON body');
  }
  const parsed = putBodySchema.safeParse(body);
  if (!parsed.success) {
    return badRequestResponse(
      'Invalid limits policy',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  }
  if (!isValidTimezone(parsed.data.timezone)) {
    return badRequestResponse('Unknown timezone');
  }
  const duplicateId = parsed.data.overrides
    .map((o) => o.id)
    .find((id, index, all) => all.indexOf(id) !== index);
  if (duplicateId) {
    return badRequestResponse('Duplicate override id', duplicateId);
  }

  const ifMatchEtag = request.headers.get('if-match');
  if (ifMatchEtag !== null && !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
    return badRequestResponse('If-Match must be a quoted strong ETag');
  }

  const now = new Date().toISOString();
  const policy: LimitsPolicy = {
    version: 1,
    defaults: clampToHardCeilings(parsed.data.defaults),
    overrides: parsed.data.overrides.map((override) => ({
      ...override,
      entries: clampToHardCeilings(override.entries),
      createdBy: userMail,
      createdAt: now,
      updatedBy: userMail,
      updatedAt: now,
    })),
    mode: parsed.data.mode,
    failMode: parsed.data.failMode,
    timezone: parsed.data.timezone,
    countByomUsage: parsed.data.countByomUsage,
    countAuxiliaryUsage: parsed.data.countAuxiliaryUsage,
    updatedBy: userMail,
    updatedAt: now,
  };

  try {
    const storage = createLimitsBlobStorage();
    const etag = await writePolicy(storage, policy, ifMatchEtag);
    console.log(
      `[limits-admin] action=upsert mode=${policy.mode} overrides=${policy.overrides.length} by=${sanitizeForLog(userMail)}`,
    );
    // Best-effort audit copy — never fails the write the admin just made.
    await writeHistoryEntry(storage, {
      version: 1,
      action: 'upsert',
      policy,
      updatedBy: userMail,
      updatedAt: now,
    });
    // This replica served the write, so drop its cache immediately; others
    // pick the change up within the 60s TTL.
    service.invalidate();
    return successResponse({ policy, etag });
  } catch (error) {
    if (error instanceof LimitsConflictError) {
      return errorResponse(
        'Limits policy was modified by another admin; reload and retry',
        409,
        undefined,
        'LIMITS_CONFLICT',
      );
    }
    return handleApiError(error, 'Failed to write limits policy');
  }
}
