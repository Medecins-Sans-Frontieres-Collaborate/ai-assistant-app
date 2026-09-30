/**
 * Which announcements are queued for one reader — the pure half of the
 * `/api/version` funnel (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §3).
 *
 * CONTAINMENT is evaluated here, at read time, exactly like a scoped limit
 * override: a delegated announcement reaches a reader only if the reader
 * matches its audience AND is inside the delegation's jurisdiction, and only
 * while that delegation is enabled and still offers the `announcements`
 * capability. Narrowing, disabling or deleting a delegation therefore takes
 * effect at the next poll, and a record whose delegation is gone is inert —
 * never promoted to org-wide.
 *
 * Only the reader's language leaves the server; other locales, the audience
 * and the author do not.
 */
import {
  Announcement,
  AnnouncementAudience,
  hideAfterInstant,
  httpsHostOf,
  isLive,
} from '@/lib/services/announcements/types';
import { SharedDelegation } from '@/lib/services/delegations/types';
import {
  Principal,
  matchesPrincipal,
} from '@/lib/services/shared/principalMatching';

import { AnnouncementAppMessage } from '@/types/appMessages';

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

function matchesAudience(
  principal: Principal,
  audience: AnnouncementAudience,
): boolean {
  if (audience.kind === 'everyone') return true;
  return audience.predicates.some((predicate) =>
    matchesPrincipal(principal, predicate.scope, predicate.targets),
  );
}

/** The delegation a delegated announcement may be delivered under, or null. */
function deliveringDelegation(
  announcement: Announcement,
  delegations: readonly SharedDelegation[],
): SharedDelegation | null {
  const delegation = delegations.find(
    (d) => d.id === announcement.delegationId,
  );
  if (!delegation?.enabled) return null;
  if (!delegation.capabilities.includes('announcements')) return null;
  return delegation;
}

export function isDeliverableTo(
  announcement: Announcement,
  principal: Principal,
  delegations: readonly SharedDelegation[],
  now: number,
): boolean {
  if (!isLive(announcement, now)) return false;
  if (announcement.delegationId) {
    const delegation = deliveringDelegation(announcement, delegations);
    if (!delegation) return false;
    const inJurisdiction = delegation.jurisdiction.some((predicate) =>
      matchesPrincipal(principal, predicate.scope, predicate.targets),
    );
    if (!inJurisdiction) return false;
  }
  return matchesAudience(principal, announcement.audience);
}

function endsAt(announcement: Announcement): string {
  const hideAfter = hideAfterInstant(announcement);
  const expires = Date.parse(announcement.expiresAt);
  return new Date(
    hideAfter === null ? expires : Math.min(hideAfter, expires),
  ).toISOString();
}

function toMessage(
  announcement: Announcement,
  locale: string,
  delegations: readonly SharedDelegation[],
  allowedLinkHosts: readonly string[],
): AnnouncementAppMessage | null {
  const content =
    announcement.content[locale] ??
    announcement.content[announcement.sourceLocale];
  if (!content) return null;
  const from = announcement.delegationId
    ? delegations.find((d) => d.id === announcement.delegationId)?.label
    : undefined;
  // A link without a label has nothing to show (the raw URL never is). A
  // DELEGATED link is re-checked against the allow-list at read time, so
  // removing a host retires the links already published to it.
  const label = content.actionLabel?.trim();
  const host = httpsHostOf(announcement.action?.url);
  const linkAllowed =
    host !== null &&
    (!announcement.delegationId || allowedLinkHosts.includes(host));
  return {
    kind: 'announcement',
    id: announcement.id,
    revision: announcement.revision,
    severity: announcement.severity,
    dismissible: announcement.dismissible,
    title: content.title,
    body: content.body,
    ...(announcement.action && label && linkAllowed
      ? { action: { label, url: announcement.action.url } }
      : {}),
    variables: announcement.variables,
    ...(from ? { from } : {}),
    endsAt: endsAt(announcement),
  };
}

/**
 * Deliverable announcements for `principal`, highest priority first:
 * critical → warning → info, newest first within a severity.
 */
export function selectAnnouncementsFor(input: {
  announcements: readonly Announcement[];
  delegations: readonly SharedDelegation[];
  allowedLinkHosts: readonly string[];
  principal: Principal;
  locale: string;
  now: number;
}): AnnouncementAppMessage[] {
  return input.announcements
    .filter((announcement) =>
      isDeliverableTo(
        announcement,
        input.principal,
        input.delegations,
        input.now,
      ),
    )
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        Date.parse(b.visibleFrom) - Date.parse(a.visibleFrom),
    )
    .map((announcement) =>
      toMessage(
        announcement,
        input.locale,
        input.delegations,
        input.allowedLinkHosts,
      ),
    )
    .filter((message): message is AnnouncementAppMessage => message !== null);
}
