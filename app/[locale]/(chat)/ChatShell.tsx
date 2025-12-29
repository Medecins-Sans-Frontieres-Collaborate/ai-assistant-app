'use client';

import { useState } from 'react';

import { useUI } from '@/client/hooks/ui/useUI';

import { LocalStorageService } from '@/client/services/storage/localStorageService';

import { MigrationDialog } from '@/components/Migration/MigrationDialog';
import { AppInitializer } from '@/components/Providers/AppInitializer';
import { SettingDialog } from '@/components/Settings/SettingDialog';
import { Sidebar } from '@/components/Sidebar/Sidebar';

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

  const handleMigrationComplete = () => {
    setShowMigrationDialog(false);
    // Reload to ensure stores pick up migrated data
    window.location.reload();
  };

  return (
    <>
      <MigrationDialog
        isOpen={showMigrationDialog}
        onComplete={handleMigrationComplete}
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
