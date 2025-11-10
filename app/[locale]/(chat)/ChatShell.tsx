'use client';

import { useUI } from '@/client/hooks/ui/useUI';

import { AppInitializer } from '@/components/Providers/AppInitializer';
import { SettingDialog } from '@/components/Settings/SettingDialog';
import { Sidebar } from '@/components/Sidebar/Sidebar';

/**
 * Chat application shell - stable client component for layout structure
 * Contains persistent UI elements (Sidebar, Settings) that shouldn't remount
 * Children are the page content that can change/remount freely
 */
export function ChatShell({ children }: { children: React.ReactNode }) {
  const { showChatbar } = useUI();

  return (
    <>
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
