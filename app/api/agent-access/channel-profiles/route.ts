import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  deleteChannelProfile,
  listAllChannelProfiles,
  readChannelProfile,
  writeChannelProfile,
  writeChannelProfileHistoryEntry,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  AdminChannelProfile,
  AdminChannelProfileHistoryEntry,
  CHANNEL_PROFILE_SOURCE,
  CUSTOM_CHANNEL_PROFILE_ID_PATTERN,
  ChannelProfileDataSchema,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';
import { invalidateChannelProfileCache } from '@/lib/services/workflows/channelDrafter/channelProfileService';

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
import { CHANNEL_PROFILES } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import {
  isBuiltInChannelId,
  profileDataOf,
} from '@/lib/utils/shared/drafter/channels/effectiveProfiles';

import { auth } from '@/auth';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * Admin CRUD for channel profiles (docs/CHANNEL_DRAFTER_DESIGN.md §4.1).
 *
 * GLOBAL ADMINS ONLY, on every verb. A profile's limits drive hard checks
 * and the prompt for the whole organisation, like the workflow policy and
 * the usage limits; there is no per-key delegation here, so none of the
 * scoped-admin machinery applies.
 *
 * A record either OVERRIDES a built-in profile (POST with that built-in's
 * id) or adds a channel of the organisation's own (POST without an id, which
 * mints `chan-<hex>`). DELETE of an override restores the built-in.
 */

const bodySchema = z
  .object({
    id: z.string().trim().min(1).max(60).optional(),
    enabled: z.boolean(),
    profile: ChannelProfileDataSchema,
  })
  .strict();

function conflictResponse(service: AgentAccessService) {
  service.invalidate();
  invalidateChannelProfileCache();
  return errorResponse(
    'Channel profile was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

async function appendHistoryBestEffort(
  entry: AdminChannelProfileHistoryEntry,
): Promise<void> {
  try {
    await writeChannelProfileHistoryEntry(
      createAgentAccessBlobStorage(),
      entry,
    );
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/** Session + global-admin gate shared by every verb. */
async function requireGlobalAdmin(service: AgentAccessService) {
  const session = await auth();
  if (!session?.user) return { response: unauthorizedResponse() } as const;
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return { response: forbiddenResponse() } as const;
  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  if (!status.isGlobalAdmin) return { response: forbiddenResponse() } as const;
  return { userMail } as const;
}

async function parseBody(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { error: badRequestResponse('Invalid JSON body') } as const;
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      error: badRequestResponse(
        'Invalid channel profile',
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      ),
    } as const;
  }
  const { profile } = parsed.data;
  // A slot longer than a post, or a thread on a one-post channel that still
  // numbers its posts, is incoherent data the checks would act on.
  if (profile.slots.some((slot) => slot.maxChars > profile.segmentLimit)) {
    return {
      error: badRequestResponse(
        'Invalid channel profile',
        'slots: the opening line cannot be longer than a post',
      ),
    } as const;
  }
  return { body: parsed.data } as const;
}

export async function GET() {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireGlobalAdmin(service);
    if ('response' in gate) return gate.response;

    const stored = await listAllChannelProfiles(createAgentAccessBlobStorage());
    return successResponse({
      // The built-in values, so the editor can show what a record overrides
      // and what "Restore the built-in" goes back to.
      builtIns: CHANNEL_PROFILES.map((profile) => ({
        id: profile.id,
        profile: profileDataOf(profile),
      })),
      records: stored.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        record: entry.record,
        etag: entry.etag,
      })),
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list channel profiles');
  }
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireGlobalAdmin(service);
    if ('response' in gate) return gate.response;
    const parsed = await parseBody(request);
    if ('error' in parsed) return parsed.error;

    // An id may only name a built-in (an override). Anything else is minted
    // here, so a caller can never choose a blob path.
    const requested = parsed.body.id;
    if (requested !== undefined && !isBuiltInChannelId(requested)) {
      return badRequestResponse('id must be a built-in channel id');
    }
    const id =
      requested ?? `chan-${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
    const storage = createAgentAccessBlobStorage();
    if ((await readChannelProfile(storage, id)) !== null) {
      return errorResponse(
        'This channel already has a record; update it instead',
        409,
        undefined,
        'AGENT_ACCESS_CONFLICT',
      );
    }

    const now = new Date().toISOString();
    const record: AdminChannelProfile = {
      version: 1,
      id,
      enabled: parsed.body.enabled,
      profile: parsed.body.profile,
      createdBy: gate.userMail,
      createdAt: now,
      updatedBy: gate.userMail,
      updatedAt: now,
    };
    // `null` = create-only: a concurrent create loses with a conflict.
    const etag = await writeChannelProfile(storage, record, null);
    const canonicalKey = canonicalAgentKey(CHANNEL_PROFILE_SOURCE, id);
    service.invalidate();
    invalidateChannelProfileCache();
    auditAdminWrite('channel-profile-upsert', canonicalKey, gate.userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      record,
      updatedBy: gate.userMail,
      updatedAt: now,
    });
    return successResponse({ record, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return conflictResponse(service);
    return handleApiError(error, 'Failed to create channel profile');
  }
}

export async function PUT(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireGlobalAdmin(service);
    if ('response' in gate) return gate.response;
    const parsed = await parseBody(request);
    if ('error' in parsed) return parsed.error;

    const id = parsed.body.id;
    if (
      !id ||
      !(isBuiltInChannelId(id) || CUSTOM_CHANNEL_PROFILE_ID_PATTERN.test(id))
    ) {
      return badRequestResponse('id is not a valid channel profile id');
    }
    const ifMatchEtag = request.headers.get('if-match');
    if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
      return badRequestResponse('If-Match must be a quoted strong ETag');
    }
    const storage = createAgentAccessBlobStorage();
    const existing = await readChannelProfile(storage, id);
    if (existing === null) return notFoundResponse('Channel profile');

    const now = new Date().toISOString();
    const record: AdminChannelProfile = {
      version: 1,
      id,
      enabled: parsed.body.enabled,
      profile: parsed.body.profile,
      createdBy: existing.record.createdBy,
      createdAt: existing.record.createdAt,
      updatedBy: gate.userMail,
      updatedAt: now,
    };
    const etag = await writeChannelProfile(storage, record, ifMatchEtag);
    const canonicalKey = canonicalAgentKey(CHANNEL_PROFILE_SOURCE, id);
    service.invalidate();
    invalidateChannelProfileCache();
    auditAdminWrite('channel-profile-upsert', canonicalKey, gate.userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'upsert',
      record,
      updatedBy: gate.userMail,
      updatedAt: now,
    });
    return successResponse({ record, etag, canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return conflictResponse(service);
    return handleApiError(error, 'Failed to update channel profile');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireGlobalAdmin(service);
    if ('response' in gate) return gate.response;

    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (
      !(isBuiltInChannelId(id) || CUSTOM_CHANNEL_PROFILE_ID_PATTERN.test(id))
    ) {
      return badRequestResponse('id is not a valid channel profile id');
    }
    const ifMatchEtag = request.headers.get('if-match');
    if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
      return badRequestResponse('If-Match must be a quoted strong ETag');
    }
    const removed = await deleteChannelProfile(
      createAgentAccessBlobStorage(),
      id,
      ifMatchEtag,
    );
    if (!removed) return notFoundResponse('Channel profile');

    const now = new Date().toISOString();
    const canonicalKey = canonicalAgentKey(CHANNEL_PROFILE_SOURCE, id);
    service.invalidate();
    invalidateChannelProfileCache();
    auditAdminWrite('channel-profile-delete', canonicalKey, gate.userMail);
    await appendHistoryBestEffort({
      version: 1,
      canonicalKey,
      action: 'delete',
      record: null,
      updatedBy: gate.userMail,
      updatedAt: now,
    });
    return successResponse({ canonicalKey });
  } catch (error) {
    if (error instanceof AgentAccessConflictError)
      return conflictResponse(service);
    return handleApiError(error, 'Failed to delete channel profile');
  }
}
