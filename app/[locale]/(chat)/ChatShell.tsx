'use client';

import { useEffect, useState } from 'react';

import { useUI } from '@/client/hooks/ui/useUI';

import { LocalStorageService } from '@/client/services/storage/localStorageService';

import { shouldShowStorageWarning } from '@/lib/utils/app/storage/storageMonitor';

import { UpdateBanner } from '@/components/App/UpdateBanner';
import { MigrationDialog } from '@/components/Migration/MigrationDialog';
import { AppInitializer } from '@/components/Providers/AppInitializer';
import { SettingDialog } from '@/components/Settings/SettingDialog';
import { Sidebar } from '@/components/Sidebar/Sidebar';
import { StorageWarningDialog } from '@/components/Storage/StorageWarningDialog';

/**
 * Check if migration dialog should be shown.
 * Returns true if legacy data exists and user hasn't skipped migration.
 */
function shouldShowMigrationDialog(): boolean {
  if (typeof window === 'undefined') return false;

  // Don't show if user previously skipped
  const skipped = localStorage.getItem('data_migration_v2_skipped');
  if (skipped === 'true') return false;

  // Check if there's legacy data to migrate
  return LocalStorageService.hasLegacyData();
}

/**
 * Chat application shell - stable client component for layout structure
 * Contains persistent UI elements (Sidebar, Settings) that shouldn't remount
 * Children are the page content that can change/remount freely
 */
export function ChatShell({ children }: { children: React.ReactNode }) {
  const { showChatbar } = useUI();
  // Use lazy initialization to check for legacy data on first render
  const [showMigrationDialog, setShowMigrationDialog] = useState(
    shouldShowMigrationDialog,
  );

  // Storage warning state
  const [showStorageWarning, setShowStorageWarning] = useState(false);
  const [storageThreshold, setStorageThreshold] = useState<
    'WARNING' | 'CRITICAL' | 'EMERGENCY' | null
  >(null);

  // Check storage usage on mount (after migration check)
  useEffect(() => {
    // Don't show storage warning if migration dialog is showing
    if (showMigrationDialog) return;

    // Defer state updates to avoid synchronous cascading renders
    queueMicrotask(() => {
      // Check if storage warning should be shown
      const { shouldShow, currentThreshold } = shouldShowStorageWarning();
      if (shouldShow && currentThreshold) {
        setShowStorageWarning(true);
        setStorageThreshold(
          currentThreshold as 'WARNING' | 'CRITICAL' | 'EMERGENCY',
        );
      }
    });
  }, [showMigrationDialog]);

  const handleMigrationComplete = () => {
    setShowMigrationDialog(false);
    // Reload to ensure stores pick up migrated data
    window.location.reload();
  };

  const handleStorageWarningClose = () => {
    setShowStorageWarning(false);
  };

  return (
    <>
      <UpdateBanner />
      <MigrationDialog
        isOpen={showMigrationDialog}
        onComplete={handleMigrationComplete}
      />
      <StorageWarningDialog
        isOpen={showStorageWarning && !showMigrationDialog}
        onClose={handleStorageWarningClose}
        severity={storageThreshold}
      />
      <AppInitializer />
      <div className="flex h-screen w-screen overflow-hidden">
        <Sidebar />

        <div
          className={`flex flex-1 transition-all duration-300 ease-in-out ${
            showChatbar ? 'md:ml-[260px]' : 'md:ml-14'
          }`}
        >
          {children}
        </div>

        <SettingDialog />
      </div>
    </>
  );
}
