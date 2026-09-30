'use client';

import { useMemo, useState } from 'react';

import { useAppMessages } from '@/client/hooks/app/useAppMessages';

import {
  dismissalKey,
  loadDismissals,
  recordDismissal,
} from '@/client/utils/announcementDismissals';

import { AnnouncementBanner } from '@/components/App/AnnouncementBanner';
import { UpdateBanner } from '@/components/App/UpdateBanner';

/**
 * Owns the top banner slot for everything the `/api/version` funnel queues:
 * the "refresh, a newer build is live" reminder and admin announcements
 * (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §4). ONE poll feeds both, and ONE
 * banner shows at a time — the refresh reminder first, then announcements in
 * the order the server ranked them, stepped through rather than stacked.
 */
export function BannerHost() {
  const { isUpdateAvailable, dismissUpdate, announcements } = useAppMessages();
  // Bumped on every dismissal so the stored set is re-read.
  const [dismissalEpoch, setDismissalEpoch] = useState(0);
  const [index, setIndex] = useState(0);

  // Read straight from localStorage: nothing is queued before the first poll
  // (well after hydration), so the server render and the first client render
  // agree on "no banner" without an effect mirroring storage into state.
  const dismissed = useMemo(
    () => (announcements.length > 0 ? loadDismissals() : new Set<string>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dismissalEpoch re-reads storage
    [announcements, dismissalEpoch],
  );

  const visible = useMemo(
    () =>
      announcements.filter(
        (a) => !a.dismissible || !dismissed.has(dismissalKey(a.id, a.revision)),
      ),
    [announcements, dismissed],
  );

  if (isUpdateAvailable) {
    return <UpdateBanner isUpdateAvailable dismiss={dismissUpdate} />;
  }
  if (visible.length === 0) return null;

  const position = Math.min(index, visible.length - 1);
  const current = visible[position];
  return (
    <AnnouncementBanner
      key={dismissalKey(current.id, current.revision)}
      announcement={current}
      position={position}
      total={visible.length}
      onStep={(delta) =>
        setIndex((position + delta + visible.length) % visible.length)
      }
      onDismiss={() => {
        recordDismissal(current.id, current.revision, current.endsAt);
        setDismissalEpoch((epoch) => epoch + 1);
        setIndex(0);
      }}
    />
  );
}
