'use client';

import { useEffect, useState } from 'react';

import { useUI } from '@/client/hooks/ui/useUI';

import { LocalStorageService } from '@/client/services/storage/localStorageService';

import { shouldShowStorageWarning } from '@/lib/utils/app/storage/storageMonitor';

import { ViewAsBanner } from '@/components/Admin/ViewAs/ViewAsBanner';
import { UpdateBanner } from '@/components/App/UpdateBanner';
import { BackupModals } from '@/components/Backup/BackupModals';
import { BackupSyncBanner } from '@/components/Backup/BackupSyncBanner';
import { MigrationDialog } from '@/components/Migration/MigrationDialog';
import { AppInitializer } from '@/components/Providers/AppInitializer';
import { SettingDialog } from '@/components/Settings/SettingDialog';
import { Sidebar } from '@/components/Sidebar/Sidebar';
import { StorageWarningDialog } from '@/components/Storage/StorageWarningDialog';

import { usePathname } from '@/lib/navigation';

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
  // Admin is a full-page surface like the help center: the conversation
  // sidebar is not interactable there and only confuses the UI, so it is
  // not rendered and the content takes the full viewport. Admin stays
  // inside this shell (rather than its own route group) so the settings
  // modal host below remains mounted — AdminShell's gear opens it directly.
  const pathname = usePathname();
  const isAdminRoute = pathname === '/admin' || pathname.startsWith('/admin/');
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
      <ViewAsBanner />
      <BackupSyncBanner />
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
      {/* h-dvh, not h-screen: `100vh` is the *large* viewport, so on mobile
          browsers the bottom of the layout — including the composer — sits
          under the URL bar. `w-full` rather than `w-screen` because `100vw`
          includes the scrollbar gutter and overflows horizontally. */}
      <div className="flex h-dvh w-full overflow-hidden">
        {!isAdminRoute && <Sidebar />}

        <div
          className={
            isAdminRoute
              ? 'flex min-w-0 flex-1'
              : `flex min-w-0 flex-1 transition-all duration-300 ease-in-out ${
                  showChatbar ? 'md:ml-[260px]' : 'md:ml-14'
                }`
          }
        >
          {children}
        </div>

        <SettingDialog />
        {/* Encrypted-backup modal host + sync triggers (flag-gated inside). */}
        <BackupModals />
      </div>
    </>
  );
}
