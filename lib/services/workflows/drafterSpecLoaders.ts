/**
 * Composition root for server-side spec resolution in the drafter routes.
 *
 * The routes are kind-agnostic and the shared drafter code may not import a
 * kind's own modules, so the one place that knows "channel specs come from
 * admin-editable profiles behind access rules" lives here, outside both.
 * A kind with no loader resolves through its adapter's built-in list.
 */
import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { ChannelProfilesUnavailableError } from '@/lib/services/workflows/channelDrafter/channelProfileService';
import { loadChannelSetFor } from '@/lib/services/workflows/channelDrafter/channelSetService';

import { errorResponse } from '@/lib/utils/server/api/apiResponse';
import { SpecAdapter } from '@/lib/utils/shared/drafter/core/adapter';

import { VersionSpec } from '@/types/drafter';

export type SpecResolver = (id: string) => VersionSpec | undefined;

export type SpecResolverResult =
  | { ok: true; resolve: SpecResolver }
  /** The caller's specs cannot be known right now; return `response`. */
  | { ok: false; response: NextResponse };

/**
 * A resolver for the specs THIS caller may write for, within the rule set
 * the request names (`setId`; absent = the default set). Loaded once per
 * request; an id the caller cannot use, or a set they cannot, resolves to
 * nothing, exactly like an id that does not exist, so a request cannot
 * probe for restricted channels.
 *
 * Not ok when the organisation's channel records cannot be read at all:
 * resolving against the built-ins would write for a channel an admin
 * switched off, so the request is refused (503) instead.
 */
export async function loadSpecResolver(
  adapter: SpecAdapter<VersionSpec>,
  request: NextRequest,
  session: Session,
  setId?: unknown,
): Promise<SpecResolverResult> {
  if (adapter.kind !== 'channel') {
    return { ok: true, resolve: (id) => adapter.resolveSpec(id) };
  }
  try {
    const set = await loadChannelSetFor(
      request,
      session,
      typeof setId === 'string' ? setId : undefined,
    );
    const byId = new Map<string, VersionSpec>(
      (set?.channels ?? []).map((profile) => [profile.id, profile]),
    );
    return { ok: true, resolve: (id) => byId.get(id) };
  } catch (error) {
    if (!(error instanceof ChannelProfilesUnavailableError)) throw error;
    return {
      ok: false,
      response: errorResponse(
        error.message,
        error.status,
        undefined,
        error.code,
      ),
    };
  }
}
