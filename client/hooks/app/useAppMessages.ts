import { useCallback, useEffect, useRef, useState } from 'react';

import { useLocale } from 'next-intl';

import { AnnouncementAppMessage, AppMessage } from '@/types/appMessages';

const CLIENT_BUILD = process.env.NEXT_PUBLIC_BUILD || 'unknown';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_DELAY_MS = 10 * 1000; // 10 seconds
const REFOCUS_DEBOUNCE_MS = 3 * 1000; // 3 seconds
const DISMISS_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

interface AppMessagesResult {
  /** A newer build is live and the reminder is not snoozed. */
  isUpdateAvailable: boolean;
  /** Snoozes the refresh reminder for an hour. */
  dismissUpdate: () => void;
  /** Admin announcements queued for this reader, highest priority first. */
  announcements: AnnouncementAppMessage[];
}

/**
 * The ONE poll the client makes for server-queued messages: `/api/version`
 * carries "a newer build is live" and admin announcements alike
 * (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §3). One timer, one request.
 *
 * The build is sent so the server can queue the `update` message; the
 * client-side build comparison is kept as a fallback, because during a
 * rolling deploy the poll can land on a replica that predates the funnel and
 * answers `{ build }` alone.
 *
 * Local dev (`NEXT_PUBLIC_BUILD` unset) polls too — without a build, so no
 * update is ever reported — or announcements could not be exercised locally.
 */
export function useAppMessages(): AppMessagesResult {
  const locale = useLocale();
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [isDismissed, setIsDismissed] = useState(false);
  const dismissTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isLocalDev = CLIENT_BUILD === 'unknown';

  const poll = useCallback(async () => {
    try {
      const query = new URLSearchParams({ locale });
      if (!isLocalDev) query.set('build', CLIENT_BUILD);
      const response = await fetch(`/api/version?${query.toString()}`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.build && typeof data.build === 'string') {
        setServerBuild(data.build);
      }
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch {
      // Silently ignore fetch failures — no false positives
    }
  }, [locale, isLocalDev]);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    let refocusTimeout: NodeJS.Timeout | null = null;

    const initialDelay = setTimeout(() => {
      poll();
      interval = setInterval(poll, POLL_INTERVAL_MS);
    }, INITIAL_DELAY_MS);

    // Tab refocus handler with debounce
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (refocusTimeout) clearTimeout(refocusTimeout);
      refocusTimeout = setTimeout(poll, REFOCUS_DEBOUNCE_MS);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearTimeout(initialDelay);
      if (interval) clearInterval(interval);
      if (refocusTimeout) clearTimeout(refocusTimeout);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [poll]);

  useEffect(
    () => () => {
      if (dismissTimeoutRef.current) clearTimeout(dismissTimeoutRef.current);
    },
    [],
  );

  const dismissUpdate = useCallback(() => {
    setIsDismissed(true);
    // Auto-clear dismiss after cooldown so banner re-appears
    if (dismissTimeoutRef.current) clearTimeout(dismissTimeoutRef.current);
    dismissTimeoutRef.current = setTimeout(() => {
      setIsDismissed(false);
    }, DISMISS_COOLDOWN_MS);
  }, []);

  const isMismatch =
    !isLocalDev &&
    (messages.some((message) => message.kind === 'update') ||
      (serverBuild !== null &&
        serverBuild !== 'unknown' &&
        serverBuild !== CLIENT_BUILD));

  return {
    isUpdateAvailable: isMismatch && !isDismissed,
    dismissUpdate,
    announcements: messages.filter(
      (message): message is AnnouncementAppMessage =>
        message.kind === 'announcement',
    ),
  };
}
