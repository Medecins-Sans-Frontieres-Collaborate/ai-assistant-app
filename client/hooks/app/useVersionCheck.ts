import { useCallback, useEffect, useRef, useState } from 'react';

const CLIENT_BUILD = process.env.NEXT_PUBLIC_BUILD || 'unknown';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const INITIAL_DELAY_MS = 10 * 1000; // 10 seconds
const REFOCUS_DEBOUNCE_MS = 3 * 1000; // 3 seconds
const DISMISS_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

interface VersionCheckResult {
  isUpdateAvailable: boolean;
  dismiss: () => void;
}

export function useVersionCheck(): VersionCheckResult {
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const initialDelayRef = useRef<NodeJS.Timeout | null>(null);
  const refocusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isLocalDev = CLIENT_BUILD === 'unknown';

  const checkVersion = useCallback(async () => {
    try {
      const response = await fetch('/api/version');
      if (!response.ok) return;
      const data = await response.json();
      if (data.build && typeof data.build === 'string') {
        setServerBuild(data.build);
      }
    } catch {
      // Silently ignore fetch failures — no false positives
    }
  }, []);

  // Set up polling and visibility listener
  useEffect(() => {
    if (isLocalDev) return;

    // Initial delay before first check
    initialDelayRef.current = setTimeout(() => {
      checkVersion();

      // Start regular polling
      intervalRef.current = setInterval(checkVersion, POLL_INTERVAL_MS);
    }, INITIAL_DELAY_MS);

    // Tab refocus handler with debounce
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;

      if (refocusTimeoutRef.current) {
        clearTimeout(refocusTimeoutRef.current);
      }
      refocusTimeoutRef.current = setTimeout(checkVersion, REFOCUS_DEBOUNCE_MS);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (initialDelayRef.current) clearTimeout(initialDelayRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (refocusTimeoutRef.current) clearTimeout(refocusTimeoutRef.current);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isLocalDev, checkVersion]);

  const dismiss = useCallback(() => {
    setDismissedAt(Date.now());
  }, []);

  // Determine if update banner should show
  const isMismatch =
    !isLocalDev &&
    serverBuild !== null &&
    serverBuild !== 'unknown' &&
    serverBuild !== CLIENT_BUILD;

  const isDismissActive =
    dismissedAt !== null && Date.now() - dismissedAt < DISMISS_COOLDOWN_MS;

  const isUpdateAvailable = isMismatch && !isDismissActive;

  return { isUpdateAvailable, dismiss };
}
