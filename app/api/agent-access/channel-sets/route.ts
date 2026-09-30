import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  deleteChannelSet,
  deleteRule,
  listAllChannelProfiles,
  listAllChannelSets,
  readChannelSet,
  readRule,
  writeChannelSet,
  writeChannelSetHistoryEntry,
  writeRule,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveAdminStatus } from '@/lib/services/agentAccess/adminAuth';
import {
  STRONG_ETAG_REGEX,
  auditAdminWrite,
  canEditKey,
  delegateToCreator,
} from '@/lib/services/agentAccess/adminRouteHelpers';
import {
  CHANNEL_SET_SOURCE,
  ChannelRuleSet,
  ChannelRuleSetHistoryEntry,
  ChannelSetData,
  ChannelSetDataSchema,
  DEFAULT_CHANNEL_SET_ID,
  PUBLISH_SOURCE,
  canonicalAgentKey,
  isChannelSetId,
} from '@/lib/services/agentAccess/types';
import { invalidateChannelSetCache } from '@/lib/services/workflows/channelDrafter/channelSetService';

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
import { virtualDefaultSet } from '@/lib/utils/shared/drafter/channels/channelSets';
import { effectiveChannelProfiles } from '@/lib/utils/shared/drafter/channels/effectiveProfiles';
import { normalizeHttpUrl } from '@/lib/utils/shared/drafter/core/brief';

import { auth } from '@/auth';
import { randomUUID } from 'crypto';
import { z } from 'zod';

/**
 * Admin CRUD for channel RULE SETS (docs/CHANNEL_DRAFTER_DESIGN.md §4.1):
 * one team's house rules over the global platforms.
 *
 * ANY admin may create a set; a local admin's creation is delegated to them
 * (`channel-set::<id>`), so a section's comms lead owns their own set and
 * never touches the platforms. Edits and deletes need that key. A new set
 * starts RESTRICTED to its creator: the audience rule is written before the
 * record, so there is never a moment when a half-made set is open to
 * everyone. "Everyone" is then an explicit choice in the rule editor.
 *
 * The built-in default set has no record until an admin edits it; PUT on
 * `default` with no record creates one.
 */

const bodySchema = z
  .object({
    id: z.string().trim().min(1).max(60).optional(),
    data: ChannelSetDataSchema,
  })
  .strict();

function conflictResponse(service: AgentAccessService) {
  service.invalidate();
  invalidateChannelSetCache();
  return errorResponse(
    'Channel set was modified by another admin; reload and retry',
    409,
    undefined,
    'AGENT_ACCESS_CONFLICT',
  );
}

async function appendHistoryBestEffort(
  entry: ChannelRuleSetHistoryEntry,
): Promise<void> {
  try {
    await writeChannelSetHistoryEntry(createAgentAccessBlobStorage(), entry);
  } catch (error) {
    console.error(
      `[agent-access-admin] HISTORY WRITE FAILED for key=${sanitizeForLog(entry.canonicalKey)} action=${entry.action}: ${sanitizeForLog(error)}`,
    );
  }
}

/**
 * Removes the rules that hang off a deleted set: its audience rule and the
 * sending rules of its channels. Best effort: a rule left behind grants
 * nothing (its set no longer resolves) but would show in the rules list and
 * would apply again to a set that reused the id, which ids never do.
 */
async function removeRulesOfSet(
  service: AgentAccessService,
  setId: string,
  userMail: string,
): Promise<void> {
  const storage = createAgentAccessBlobStorage();
  const sendingPrefix = canonicalAgentKey(PUBLISH_SOURCE, `${setId}/`);
  const keys = [
    canonicalAgentKey(CHANNEL_SET_SOURCE, setId),
    ...service
      .getSnapshot()
      .rules.map((stored) => stored.canonicalKey)
      .filter((key) => key.startsWith(sendingPrefix)),
  ];
  for (const key of keys) {
    try {
      const existing = await readRule(storage, key);
      if (existing && (await deleteRule(storage, key, existing.etag))) {
        auditAdminWrite('rule-delete', key, userMail);
      }
    } catch (error) {
      console.error(
        `[agent-access-admin] could not remove rule ${sanitizeForLog(key)} of deleted set: ${sanitizeForLog(error)}`,
      );
    }
  }
}

/**
 * Fields only a GLOBAL admin may set. A Hootsuite profile id names whose
 * account a post goes out under, and `isDefault` decides where the whole
 * organisation lands: neither is a team's own business. A set owner's PUT
 * keeps the stored values; a create gets none.
 */
function keepGlobalFacts(
  data: ChannelSetData,
  existing: ChannelRuleSet | null,
): ChannelSetData {
  const channels = Object.fromEntries(
    Object.entries(data.channels).map(([id, rule]) => {
      const { publishTarget: _requested, ...rest } = rule;
      const kept = existing?.channels[id]?.publishTarget;
      return [id, kept ? { ...rest, publishTarget: kept } : rest];
    }),
  );
  return { ...data, channels, isDefault: existing?.isDefault ?? false };
}

/** A set as another admin may read it: without the Hootsuite profile ids. */
function withoutPublishTargets(record: ChannelRuleSet): ChannelRuleSet {
  return {
    ...record,
    channels: Object.fromEntries(
      Object.entries(record.channels).map(([id, rule]) => {
        const { publishTarget: _hidden, ...rest } = rule;
        return [id, rest];
      }),
    ),
  };
}

/** Session + any-admin gate shared by every verb. */
async function requireAdmin(service: AgentAccessService) {
  const session = await auth();
  if (!session?.user) return { response: unauthorizedResponse() } as const;
  const userMail = session.user.mail?.trim().toLowerCase();
  if (!userMail) return { response: forbiddenResponse() } as const;
  await service.ensureFresh();
  const status = resolveAdminStatus(session.user, service.getSnapshot().config);
  if (!status.isGlobalAdmin && !status.isLocalAdmin) {
    return { response: forbiddenResponse() } as const;
  }
  return { userMail, status } as const;
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
        'Invalid channel set',
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      ),
    } as const;
  }
  const { data } = parsed.data;
  if (
    data.defaults.donationUrl &&
    !normalizeHttpUrl(data.defaults.donationUrl)
  ) {
    return {
      error: badRequestResponse(
        'Invalid channel set',
        'defaults.donationUrl: must be a web address',
      ),
    } as const;
  }
  const known = new Set(Object.keys(data.channels));
  if (data.defaults.channelIds.some((id) => !known.has(id))) {
    return {
      error: badRequestResponse(
        'Invalid channel set',
        'defaults.channelIds: every default channel must be in the set',
      ),
    } as const;
  }
  return {
    body: {
      ...parsed.data,
      data: {
        ...data,
        defaults: {
          ...data.defaults,
          donationUrl: data.defaults.donationUrl
            ? (normalizeHttpUrl(data.defaults.donationUrl) ?? undefined)
            : undefined,
        },
      },
    },
  } as const;
}

function recordOf(
  id: string,
  data: z.infer<typeof ChannelSetDataSchema>,
  stamps: Pick<ChannelRuleSet, 'createdBy' | 'createdAt'>,
  userMail: string,
  now: string,
): ChannelRuleSet {
  return {
    version: 1,
    id,
    ...data,
    ...stamps,
    updatedBy: userMail,
    updatedAt: now,
  };
}

export async function GET() {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireAdmin(service);
    if ('response' in gate) return gate.response;
    const storage = createAgentAccessBlobStorage();
    const [stored, profileRecords] = await Promise.all([
      listAllChannelSets(storage),
      listAllChannelProfiles(storage),
    ]);
    const platforms = effectiveChannelProfiles(
      profileRecords.map((entry) => ({
        id: entry.record.id,
        enabled: entry.record.enabled,
        profile: entry.record.profile,
      })),
    );
    const sets = stored.map((entry) => {
      const canEdit = canEditKey(gate.status, entry.canonicalKey);
      return {
        canonicalKey: entry.canonicalKey,
        // Another team's Hootsuite profile ids are not for copying.
        record: canEdit ? entry.record : withoutPublishTargets(entry.record),
        etag: entry.etag,
        canEdit,
      };
    });
    return successResponse({
      sets,
      // The implicit default, for the editor, until an admin stores it.
      virtualDefault: stored.some((e) => e.record.id === DEFAULT_CHANNEL_SET_ID)
        ? null
        : {
            id: DEFAULT_CHANNEL_SET_ID,
            data: virtualDefaultSet(platforms),
            canEdit: canEditKey(
              gate.status,
              canonicalAgentKey(CHANNEL_SET_SOURCE, DEFAULT_CHANNEL_SET_ID),
            ),
          },
      platforms,
      canCreate: true,
    });
  } catch (error) {
    return handleApiError(error, 'Failed to list channel sets');
  }
}

export async function POST(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireAdmin(service);
    if ('response' in gate) return gate.response;
    const parsed = await parseBody(request);
    if ('error' in parsed) return parsed.error;
    if (parsed.body.id !== undefined) {
      return badRequestResponse('A new set cannot choose its id');
    }

    const id = `set-${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
    const canonicalKey = canonicalAgentKey(CHANNEL_SET_SOURCE, id);
    const now = new Date().toISOString();
    const storage = createAgentAccessBlobStorage();

    // Audience first: restricted to the creator until they share it.
    await writeRule(
      storage,
      {
        version: 1,
        source: CHANNEL_SET_SOURCE,
        agentName: id,
        access: {
          type: 'restricted',
          allowUsers: [gate.userMail],
          allowDomains: [],
          allowGroups: [],
        },
        updatedBy: gate.userMail,
        updatedAt: now,
      },
      null,
    );
    const record = recordOf(
      id,
      gate.status.isGlobalAdmin
        ? { ...parsed.body.data, isDefault: false }
        : keepGlobalFacts(parsed.body.data, null),
      { createdBy: gate.userMail, createdAt: now },
      gate.userMail,
      now,
    );
    const etag = await writeChannelSet(storage, record, null);
    service.invalidate();
    invalidateChannelSetCache();
    auditAdminWrite('channel-set-upsert', canonicalKey, gate.userMail);

    if (!gate.status.isGlobalAdmin) {
      const delegated = await delegateToCreator(gate.userMail, canonicalKey);
      if (!delegated) {
        // The set stays restricted to its creator, so nothing leaks; but an
        // unowned set can never be edited, so it is removed again.
        const rolledBack = await deleteChannelSet(storage, id, etag).catch(
          () => false,
        );
        if (rolledBack) await removeRulesOfSet(service, id, gate.userMail);
        service.invalidate();
        invalidateChannelSetCache();
        return errorResponse(
          rolledBack
            ? 'Could not delegate the new set to you; nothing was created'
            : 'Could not delegate the new set to you; ask a global admin to remove it',
          500,
          undefined,
          'DELEGATION_FAILED',
        );
      }
    }
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
    return handleApiError(error, 'Failed to create channel set');
  }
}

export async function PUT(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireAdmin(service);
    if ('response' in gate) return gate.response;
    const parsed = await parseBody(request);
    if ('error' in parsed) return parsed.error;

    const id = parsed.body.id;
    if (!id || !isChannelSetId(id)) {
      return badRequestResponse('id is not a valid channel set id');
    }
    const canonicalKey = canonicalAgentKey(CHANNEL_SET_SOURCE, id);
    if (!canEditKey(gate.status, canonicalKey)) return forbiddenResponse();

    const ifMatchEtag = request.headers.get('if-match');
    const storage = createAgentAccessBlobStorage();
    const existing = await readChannelSet(storage, id);
    const now = new Date().toISOString();
    let etag: string;
    let record: ChannelRuleSet;
    if (existing === null) {
      // Only the built-in default exists without a record: editing it for
      // the first time stores it, create-only.
      if (id !== DEFAULT_CHANNEL_SET_ID) return notFoundResponse('Channel set');
      record = recordOf(
        id,
        gate.status.isGlobalAdmin
          ? parsed.body.data
          : keepGlobalFacts(parsed.body.data, null),
        { createdBy: gate.userMail, createdAt: now },
        gate.userMail,
        now,
      );
      etag = await writeChannelSet(storage, record, null);
    } else {
      if (ifMatchEtag === null && id === DEFAULT_CHANNEL_SET_ID) {
        // The caller edited the built-in default, but another admin stored
        // it first: a conflict to reload from, not a malformed request.
        return conflictResponse(service);
      }
      if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
        return badRequestResponse('If-Match must be a quoted strong ETag');
      }
      record = recordOf(
        id,
        gate.status.isGlobalAdmin
          ? parsed.body.data
          : keepGlobalFacts(parsed.body.data, existing.record),
        {
          createdBy: existing.record.createdBy,
          createdAt: existing.record.createdAt,
        },
        gate.userMail,
        now,
      );
      etag = await writeChannelSet(storage, record, ifMatchEtag);
    }
    service.invalidate();
    invalidateChannelSetCache();
    auditAdminWrite('channel-set-upsert', canonicalKey, gate.userMail);
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
    return handleApiError(error, 'Failed to update channel set');
  }
}

export async function DELETE(request: NextRequest) {
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) return notFoundResponse('Resource');
  try {
    const gate = await requireAdmin(service);
    if ('response' in gate) return gate.response;

    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (!isChannelSetId(id)) {
      return badRequestResponse('id is not a valid channel set id');
    }
    const canonicalKey = canonicalAgentKey(CHANNEL_SET_SOURCE, id);
    if (!canEditKey(gate.status, canonicalKey)) return forbiddenResponse();
    const ifMatchEtag = request.headers.get('if-match');
    if (ifMatchEtag === null || !STRONG_ETAG_REGEX.test(ifMatchEtag)) {
      return badRequestResponse('If-Match must be a quoted strong ETag');
    }
    // Deleting the default's record restores the built-in default.
    const removed = await deleteChannelSet(
      createAgentAccessBlobStorage(),
      id,
      ifMatchEtag,
    );
    if (!removed) return notFoundResponse('Channel set');

    const now = new Date().toISOString();
    // The built-in default keeps its rules: deleting its record only
    // restores the built-in values, and its audience still applies.
    if (id !== DEFAULT_CHANNEL_SET_ID) {
      await removeRulesOfSet(service, id, gate.userMail);
    }
    service.invalidate();
    invalidateChannelSetCache();
    auditAdminWrite('channel-set-delete', canonicalKey, gate.userMail);
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
    return handleApiError(error, 'Failed to delete channel set');
  }
}
