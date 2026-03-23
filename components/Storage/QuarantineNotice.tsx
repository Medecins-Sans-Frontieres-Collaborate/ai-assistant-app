'use client';

import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { getQuarantinedCount } from '@/lib/utils/app/storage/quarantineStore';

import { QuarantineDialog } from './QuarantineDialog';

/**
 * Small banner that appears when quarantined conversations exist.
 * Shows a count and a button to open the recovery dialog.
 */
export function QuarantineNotice() {
  const [count, setCount] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    // Check on mount (deferred to avoid blocking render)
    queueMicrotask(() => {
      setCount(getQuarantinedCount());
    });
  }, []);

  // Re-check after dialog closes (items may have been recovered/deleted)
  const handleDialogClose = () => {
    setDialogOpen(false);
    setCount(getQuarantinedCount());
  };

  if (count === 0) return null;

  return (
    <>
      <div className="mx-3 mb-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
        <IconAlertTriangle size={14} className="flex-shrink-0" />
        <span className="flex-1">
          {count} conversation{count !== 1 ? 's' : ''} had data issues and{' '}
          {count !== 1 ? 'were' : 'was'} quarantined.
        </span>
        <button
          onClick={() => setDialogOpen(true)}
          className="font-medium underline hover:no-underline whitespace-nowrap"
        >
          Review
        </button>
      </div>
      <QuarantineDialog isOpen={dialogOpen} onClose={handleDialogClose} />
    </>
  );
}
