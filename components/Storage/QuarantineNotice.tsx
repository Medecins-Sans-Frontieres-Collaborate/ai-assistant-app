'use client';

import { IconAlertTriangle, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { getQuarantinedCount } from '@/lib/utils/app/storage/quarantineStore';

import { QuarantineDialog } from './QuarantineDialog';

const DISMISSED_COUNT_KEY = 'quarantine-notice-dismissed-count';

/**
 * Small banner that appears when quarantined conversations exist.
 * Shows a count and a button to open the recovery dialog.
 * Can be dismissed — reappears if new items are quarantined.
 */
export function QuarantineNotice() {
  const t = useTranslations('quarantine');
  const [count, setCount] = useState(0);
  const [dismissed, setDismissed] = useState(true); // default hidden until checked
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      const currentCount = getQuarantinedCount();
      setCount(currentCount);

      if (currentCount === 0) {
        setDismissed(true);
        return;
      }

      // Show if current count exceeds the dismissed count (new items quarantined)
      const dismissedCount = parseInt(
        localStorage.getItem(DISMISSED_COUNT_KEY) || '0',
        10,
      );
      setDismissed(currentCount <= dismissedCount);
    });
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_COUNT_KEY, String(count));
    } catch {
      // Best-effort
    }
  };

  // Re-check after dialog closes (items may have been recovered/deleted)
  const handleDialogClose = () => {
    setDialogOpen(false);
    const newCount = getQuarantinedCount();
    setCount(newCount);
    if (newCount === 0) {
      setDismissed(true);
      try {
        localStorage.removeItem(DISMISSED_COUNT_KEY);
      } catch {
        // Best-effort
      }
    }
  };

  if (count === 0 || dismissed) return null;

  return (
    <>
      <div className="absolute top-2 left-3 right-3 z-10 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2 shadow-sm">
        <IconAlertTriangle size={14} className="flex-shrink-0" />
        <span className="flex-1">{t('bannerMessage', { count })}</span>
        <button
          onClick={() => setDialogOpen(true)}
          className="font-medium underline hover:no-underline whitespace-nowrap"
        >
          {t('review')}
        </button>
        <button
          onClick={handleDismiss}
          className="p-0.5 rounded hover:bg-amber-200 dark:hover:bg-amber-800/30 transition-colors"
          aria-label={t('close')}
        >
          <IconX size={14} />
        </button>
      </div>
      <QuarantineDialog isOpen={dialogOpen} onClose={handleDialogClose} />
    </>
  );
}
