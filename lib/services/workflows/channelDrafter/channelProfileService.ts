/**
 * The PLATFORMS, server-side: the built-in profiles with the organisation's
 * corrections applied. Platforms are global facts (what X counts, how long a
 * LinkedIn post may be), so there is no per-user filtering here; who may
 * write for what is decided by the channel SETS (channelSetService.ts).
 *
 * Two modes, following the access service's own contract, kept because the
 * set service builds on this call: DISCOVERY (listing) tolerates an outage,
 * INVOCATION (writing) does not.
 *
 * Records are cached per process for a short TTL, and the last list that
 * loaded successfully keeps serving through a storage failure. Falling back
 * to the bare built-ins instead would quietly bring back a channel an admin
 * switched off. With NO list ever loaded (a cold replica during an outage)
 * there is nothing honest to serve: discovery shows the built-ins, because
 * listing grants nothing, and invocation fails closed.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  listAllChannelProfiles,
} from '@/lib/services/agentAccess/accessRulesStore';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  ChannelProfileRecord,
  effectiveChannelProfiles,
} from '@/lib/utils/shared/drafter/channels/effectiveProfiles';

import { ChannelProfile } from '@/types/drafter';

const RECORDS_TTL_MS = 60_000;

let cached: { at: number; records: ChannelProfileRecord[] } | null = null;
let inFlight: Promise<ChannelProfileRecord[] | null> | null = null;

/**
 * The organisation's channel records could not be read and none were ever
 * cached, so what an admin switched off or corrected is unknown. Carries
 * `status`, which handleApiError turns into the response status.
 */
export class ChannelProfilesUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'CHANNEL_PROFILES_UNAVAILABLE';

  constructor() {
    super('Channel settings are unavailable right now; try again shortly');
    this.name = 'ChannelProfilesUnavailableError';
  }
}

/** Drops the cache; admin writes call this so their change shows at once. */
export function invalidateChannelProfileCache(): void {
  cached = null;
}

/** The records, the last known good ones, or null when there are neither. */
async function loadRecords(): Promise<ChannelProfileRecord[] | null> {
  // An admin write on any replica bumps the rules snapshot (through its
  // generation sentinel) within seconds; a records cache older than that
  // snapshot is dropped with it, so the two never disagree for a minute.
  const rulesFetchedAt =
    AgentAccessService.getInstance().getSnapshot().fetchedAt ?? 0;
  if (cached && cached.at < rulesFetchedAt) cached = null;
  if (cached && Date.now() - cached.at < RECORDS_TTL_MS) return cached.records;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const stored = await listAllChannelProfiles(
        createAgentAccessBlobStorage(),
      );
      const records = stored.map((entry) => ({
        id: entry.record.id,
        enabled: entry.record.enabled,
        profile: entry.record.profile,
      }));
      cached = { at: Date.now(), records };
      return records;
    } catch (error) {
      console.error(
        `[channel-profiles] records unavailable, serving last known good: ${sanitizeForLog(error)}`,
      );
      // Last known good if there is one. Otherwise nothing has ever been
      // read, and the caller decides what that means for its mode.
      return cached?.records ?? null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export type ChannelAccessMode = 'discovery' | 'invocation';

export async function loadChannelProfilesFor(
  request: NextRequest,
  session: Session,
  mode: ChannelAccessMode,
): Promise<ChannelProfile[]> {
  const service = AgentAccessService.getInstance();
  // Subsystem off: no records can exist and no rules apply.
  if (!service.isEnabled()) return effectiveChannelProfiles([]);

  // Group warm-up MUST precede evaluateAccess (group rules read the cache
  // synchronously). Never throws.
  await resolveUserGroupIds(request, session);
  await service.ensureFresh();

  const records = await loadRecords();
  // Writing or sending on built-in defaults would bring back a channel an
  // admin disabled, with limits they may have corrected. Listing may.
  if (!records && mode === 'invocation') {
    throw new ChannelProfilesUnavailableError();
  }

  return effectiveChannelProfiles(records ?? []);
}
