/**
 * The channel rule sets a given user may use, server-side, each already
 * merged with the global platforms (docs/CHANNEL_DRAFTER_DESIGN.md §4.1).
 *
 * Access follows the access service's own contract, like the platforms:
 * DISCOVERY (listing sets) passes an 'unavailable' decision through so a
 * Graph blip hides nothing, INVOCATION (writing with a set) needs a plain
 * 'allow'. The built-in Default set exists even with no record and is open
 * to everyone unless a rule says otherwise.
 *
 * Records are cached per process for a short TTL, and the last list that
 * loaded keeps serving through a storage failure. With NO list ever loaded
 * discovery shows the built-in default and invocation fails closed, for the
 * same reason as the platforms: serving defaults would bring back a set an
 * admin removed.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { AgentAccessService } from '@/lib/services/agentAccess/AgentAccessService';
import {
  createAgentAccessBlobStorage,
  listAllChannelSets,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  CHANNEL_SET_SOURCE,
  ChannelRuleSet,
} from '@/lib/services/agentAccess/types';
import { resolveUserGroupIds } from '@/lib/services/m365/groupMembership';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';
import {
  DEFAULT_CHANNEL_SET_ID,
  channelsOfSet,
  defaultVoicesOfSet,
  grantOfReason,
  virtualDefaultSet,
} from '@/lib/utils/shared/drafter/channels/channelSets';

import {
  ChannelProfile,
  ChannelSetData,
  ChannelSetSummary,
} from '@/types/drafter';

import {
  ChannelAccessMode,
  ChannelProfilesUnavailableError,
  loadChannelProfilesFor,
} from './channelProfileService';

const RECORDS_TTL_MS = 60_000;

let cached: { at: number; records: ChannelRuleSet[] } | null = null;
let inFlight: Promise<ChannelRuleSet[] | null> | null = null;

/** Drops the cache; admin writes call this so their change shows at once. */
export function invalidateChannelSetCache(): void {
  cached = null;
}

async function loadRecords(): Promise<ChannelRuleSet[] | null> {
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
      const stored = await listAllChannelSets(createAgentAccessBlobStorage());
      const records = stored.map((entry) => entry.record);
      cached = { at: Date.now(), records };
      return records;
    } catch (error) {
      console.error(
        `[channel-sets] records unavailable, serving last known good: ${sanitizeForLog(error)}`,
      );
      return cached?.records ?? null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** A set's data, as stored or as the implicit default. */
export interface LoadedChannelSet {
  id: string;
  data: ChannelSetData;
}

/** Every set that exists: the records, with the default synthesised if unstored. */
export function withDefaultSet(
  records: ReadonlyArray<ChannelRuleSet>,
  platforms: ReadonlyArray<ChannelProfile>,
): LoadedChannelSet[] {
  const sets: LoadedChannelSet[] = records.map((record) => ({
    id: record.id,
    data: {
      name: record.name,
      language: record.language,
      description: record.description,
      channels: record.channels,
      defaults: record.defaults,
      isDefault: record.isDefault,
    },
  }));
  if (!sets.some((set) => set.id === DEFAULT_CHANNEL_SET_ID)) {
    sets.unshift({
      id: DEFAULT_CHANNEL_SET_ID,
      data: virtualDefaultSet(platforms),
    });
  }
  return sets;
}

export function summarizeSet(
  set: LoadedChannelSet,
  platforms: ReadonlyArray<ChannelProfile>,
  reason: string,
): ChannelSetSummary {
  return {
    id: set.id,
    name: set.data.name,
    language: set.data.language,
    description: set.data.description,
    isDefault: set.data.isDefault,
    grant: grantOfReason(reason),
    defaults: set.data.defaults,
    defaultVoices: defaultVoicesOfSet(set.data),
    channels: channelsOfSet(set.data, platforms),
  };
}

/**
 * The sets THIS user may use, merged with the platforms. Throws
 * ChannelProfilesUnavailableError in invocation mode when nothing honest
 * can be served.
 */
export async function loadChannelSetsFor(
  request: NextRequest,
  session: Session,
  mode: ChannelAccessMode,
): Promise<ChannelSetSummary[]> {
  // Loads platforms, warms group membership and the rules snapshot; throws
  // for invocation with no platform records.
  const platforms = await loadChannelProfilesFor(request, session, mode);
  const service = AgentAccessService.getInstance();
  if (!service.isEnabled()) {
    // Subsystem off: no records can exist and no rules apply.
    return withDefaultSet([], platforms).map((set) =>
      summarizeSet(set, platforms, 'feature-disabled'),
    );
  }
  const records = await loadRecords();
  if (!records && mode === 'invocation') {
    throw new ChannelProfilesUnavailableError();
  }
  const userMail = session.user?.mail ?? undefined;
  const sets = withDefaultSet(records ?? [], platforms);
  const result: ChannelSetSummary[] = [];
  for (const set of sets) {
    const { decision, reason } = service.evaluateAccess({
      userMail,
      source: CHANNEL_SET_SOURCE,
      agentName: set.id,
    });
    // A custom set ALWAYS has an audience rule (it is written before the
    // record), so "no rule" means the rules snapshot is behind this replica's
    // records, or the set was just deleted and its rule went first. Either
    // way it is not for everyone: fail closed until the two agree. Only the
    // built-in default is open by having no rule.
    if (set.id !== DEFAULT_CHANNEL_SET_ID && reason === 'no-rule') continue;
    if (
      decision === 'allow' ||
      (mode === 'discovery' && decision === 'unavailable')
    ) {
      result.push(summarizeSet(set, platforms, reason));
    }
  }
  return result;
}

/** One set the user may write with, or undefined. */
export async function loadChannelSetFor(
  request: NextRequest,
  session: Session,
  setId: string | undefined,
): Promise<ChannelSetSummary | undefined> {
  const wanted = setId?.trim() || DEFAULT_CHANNEL_SET_ID;
  const sets = await loadChannelSetsFor(request, session, 'invocation');
  return sets.find((set) => set.id === wanted);
}

/** Group warm-up for a route that evaluates set access itself. */
export async function warmAccess(
  request: NextRequest,
  session: Session,
): Promise<void> {
  await resolveUserGroupIds(request, session);
  await AgentAccessService.getInstance().ensureFresh();
}
