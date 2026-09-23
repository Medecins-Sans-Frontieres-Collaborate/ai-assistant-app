import { type NextRequest, NextResponse } from 'next/server';

import { AnnouncementsService } from '@/lib/services/announcements/AnnouncementsService';
import { selectAnnouncementsFor } from '@/lib/services/announcements/delivery';
import { DelegationsService } from '@/lib/services/delegations/DelegationsService';
import { buildPrincipal } from '@/lib/services/limits/principal';

import { getSupportedLocales } from '@/lib/utils/app/locales';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { AppMessage, VersionResponse } from '@/types/appMessages';

import { auth } from '@/auth';

/**
 * GET /api/version — the ONE poll every open client already makes, and
 * therefore the single funnel for client messages: "a newer build is live"
 * and admin announcements alike (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §3). The
 * browser keeps one timer and one request; the server decides what is queued
 * for this caller.
 *
 *   GET /api/version?build=<client build>&locale=<xx>
 *   → { build, messages: AppMessage[] }
 *
 * Invariants:
 *  - `build` STAYS TOP-LEVEL. The clients that most need the refresh banner
 *    are old tabs running the previous bundle; they read `data.build` and
 *    know nothing about `messages`. This response only ever grows.
 *  - NEVER 401. The route has never needed a session; without one it answers
 *    `{ build, messages: [] }`. A 401 from a background poll would feed the
 *    stale-session forced-sign-out path.
 *  - NEVER fail because of messages. Anything that goes wrong computing them
 *    is logged and dropped; the refresh banner must not depend on storage.
 *  - The Principal uses the CACHED group membership only; this path never
 *    warms the Graph cache. A cold cache means a group-targeted announcement
 *    is picked up on a later poll.
 */

const SUPPORTED_LOCALES = new Set(getSupportedLocales());

function updateMessages(
  clientBuild: string | null,
  serverBuild: string,
): AppMessage[] {
  if (!clientBuild || clientBuild === 'unknown' || serverBuild === 'unknown') {
    return [];
  }
  return clientBuild === serverBuild ? [] : [{ kind: 'update' }];
}

async function announcementMessages(locale: string): Promise<AppMessage[]> {
  const session = await auth();
  if (!session?.user) return [];

  const announcements = AnnouncementsService.getInstance();
  await announcements.ensureFresh();
  const document = announcements.getDocument();
  if (!document || document.announcements.length === 0) return [];

  // Delegations only matter when something delegated could be delivered.
  const delegationsService = DelegationsService.getInstance();
  if (document.announcements.some((a) => a.delegationId)) {
    await delegationsService.ensureFresh();
  }

  return selectAnnouncementsFor({
    announcements: document.announcements,
    delegations: delegationsService.getEnabledDelegations(),
    allowedLinkHosts: document.allowedLinkHosts,
    principal: buildPrincipal(session),
    locale,
    now: Date.now(),
  });
}

export async function GET(request: NextRequest) {
  const build = process.env.NEXT_PUBLIC_BUILD ?? 'unknown';
  const params = request.nextUrl.searchParams;
  const requestedLocale = params.get('locale') ?? '';
  const locale = SUPPORTED_LOCALES.has(requestedLocale)
    ? requestedLocale
    : 'en';

  const messages: AppMessage[] = updateMessages(params.get('build'), build);
  try {
    messages.push(...(await announcementMessages(locale)));
  } catch (error) {
    console.error(
      `[version] announcements skipped for this poll: ${sanitizeForLog(error)}`,
    );
  }

  const body: VersionResponse = { build, messages };
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
