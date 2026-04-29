'use client';

import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useCreateReducer } from '@/client/hooks/ui/useCreateReducer';
import { useDebounce } from '@/client/hooks/ui/useDebounce';
import { useUI } from '@/client/hooks/ui/useUI';

import { exportData, importData } from '@/lib/utils/app/export/importExport';
import { getSettings, saveSettings } from '@/lib/utils/app/settings';
import { getStorageUsage } from '@/lib/utils/app/storage/storageMonitor';

import { SearchMode } from '@/types/searchMode';
import { DEFAULT_STREAMING_SPEED, Settings } from '@/types/settings';

import packageJson from '../../package.json';
import { MigrationDialog } from '../Migration/MigrationDialog';
import { QuarantineDialog } from '../Storage/QuarantineDialog';
import { MobileSettingsHeader } from './MobileSettingsHeader';
import { ChatSettingsSection } from './Sections/ChatSettingsSection';
import { DataManagementSection } from './Sections/DataManagementSection';
import { GeneralSection } from './Sections/GeneralSection';
import { HelpSupportSection } from './Sections/HelpSupportSection';
import { MobileAppSection } from './Sections/MobileAppSection';
import { SettingsSidebar } from './SettingsSidebar';
import { SettingsSection } from './types';

const version = packageJson.version;
const build = process.env.NEXT_PUBLIC_BUILD || 'Unknown';
const env = process.env.NEXT_PUBLIC_ENV || 'development';

/**
 * SettingDialog component adapted for Zustand stores
 */
export function SettingDialog() {
  const { data: session } = useSession();
  const { isSettingsOpen, setIsSettingsOpen, theme, setTheme } = useUI();
  const {
    temperature,
    setTemperature,
    systemPrompt,
    setSystemPrompt,
    prompts,
  } = useSettings();
  const { conversations, clearAll: clearAllConversations } = useConversations();

  const { state, dispatch } = useCreateReducer<Settings>({
    initialState: {
      theme: 'light',
      temperature: 0.5,
      systemPrompt: '',
      advancedMode: false,
      defaultSearchMode: SearchMode.INTELLIGENT, // Privacy-focused intelligent search by default
      displayNamePreference: 'firstName',
      customDisplayName: '',
      streamingSpeed: DEFAULT_STREAMING_SPEED,
      includeUserInfoInPrompt: false,
      preferredName: '',
      userContext: '',
    },
  });

  const [storageData, setStorageData] = useState<any>(null);
  const [fullProfile, setFullProfile] = useState<any>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    SettingsSection.GENERAL,
  );
  const [isMobileView, setIsMobileView] = useState<boolean>(false);
  const [showMigrationDialog, setShowMigrationDialog] = useState(false);
  const [showQuarantineDialog, setShowQuarantineDialog] = useState(false);
  const hasInitialLoadedRef = useRef(false);

  // Load settings and storage on client side only
  useEffect(() => {
    const loadedSettings = getSettings();
    Object.keys(loadedSettings).forEach((key) => {
      dispatch({
        field: key as keyof Settings,
        value: loadedSettings[key as keyof Settings],
      });
    });
    hasInitialLoadedRef.current = true;
    setStorageData(getStorageUsage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Autosave: persist state changes after a short debounce so text inputs
  // don't write to localStorage on every keystroke. Toggles still feel
  // instant because their UI is driven by reducer state, not the persist.
  // Provider setters are stable by construction, so they're safe in the
  // dep array.
  const debouncedState = useDebounce(state, 300);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  useEffect(() => {
    if (!hasInitialLoadedRef.current) return;
    saveSettings(debouncedState);
    setTheme(debouncedState.theme);
    setTemperature(debouncedState.temperature);
    setSystemPrompt(debouncedState.systemPrompt);
  }, [debouncedState, setTheme, setTemperature, setSystemPrompt]);

  // Flush the latest state on unmount so a final keystroke (especially one
  // that empties a field, like deleting the last character of Custom
  // Instructions) doesn't get dropped by the 300ms debounce when the user
  // closes the modal immediately.
  useEffect(() => {
    return () => {
      if (!hasInitialLoadedRef.current) return;
      const final = stateRef.current;
      saveSettings(final);
      setTheme(final.theme);
      setTemperature(final.temperature);
      setSystemPrompt(final.systemPrompt);
    };
    // Setters are stable; capturing them once at mount is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      // Don't close if a nested dialog is open - they're rendered outside modalRef
      if (showMigrationDialog || showQuarantineDialog) return;

      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        window.addEventListener('mouseup', handleMouseUp);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener('mouseup', handleMouseUp);
      setIsSettingsOpen(false);
    };

    if (isSettingsOpen) {
      window.addEventListener('mousedown', handleMouseDown);
    }

    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [
    isSettingsOpen,
    setIsSettingsOpen,
    showMigrationDialog,
    showQuarantineDialog,
  ]);

  // Update storage data when dialog opens
  useEffect(() => {
    if (isSettingsOpen) {
      setStorageData(getStorageUsage());
    }
  }, [isSettingsOpen]);

  // Prefetch user profile when settings opens (with localStorage caching)
  useEffect(() => {
    const fetchProfile = async () => {
      if (!isSettingsOpen || !session?.user?.id) return;

      // Check if we have a cached profile for this user
      const cacheKey = `user_profile_${session.user.id}`;
      const cachedProfile = localStorage.getItem(cacheKey);

      if (cachedProfile) {
        try {
          setFullProfile(JSON.parse(cachedProfile));
          return;
        } catch (e) {
          // Invalid cache, fetch fresh
          localStorage.removeItem(cacheKey);
        }
      }

      try {
        const response = await fetch('/api/user/profile');
        if (response.ok) {
          const profile = await response.json();
          setFullProfile(profile);
          // Cache the full profile in localStorage
          localStorage.setItem(cacheKey, JSON.stringify(profile));
        }
      } catch (error) {
        console.error('Failed to prefetch user profile:', error);
      }
    };

    if (isSettingsOpen) {
      fetchProfile();
    }
  }, [isSettingsOpen, session?.user?.id]);

  // Check for mobile view
  useEffect(() => {
    const checkMobileView = () => {
      setIsMobileView(window.innerWidth < 768);
    };

    checkMobileView();
    window.addEventListener('resize', checkMobileView);

    return () => {
      window.removeEventListener('resize', checkMobileView);
    };
  }, []);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSettingsOpen(false);
      }
    };

    if (isSettingsOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isSettingsOpen, setIsSettingsOpen]);

  const handleReset = () => {
    const defaultTheme: 'light' | 'dark' = window.matchMedia(
      '(prefers-color-scheme: dark)',
    ).matches
      ? 'dark'
      : 'light';
    const defaultSettings: Settings = {
      theme: defaultTheme,
      temperature: 0.5,
      systemPrompt: process.env.NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT || '',
      advancedMode: false,
      defaultSearchMode: SearchMode.INTELLIGENT, // Privacy-focused intelligent search by default
      displayNamePreference: 'firstName',
      customDisplayName: '',
      streamingSpeed: DEFAULT_STREAMING_SPEED,
      includeUserInfoInPrompt: false,
      preferredName: '',
      userContext: '',
    };
    setTheme(defaultTheme);
    setTemperature(0.5);
    setSystemPrompt(process.env.NEXT_PUBLIC_DEFAULT_SYSTEM_PROMPT || '');
    saveSettings(defaultSettings);
  };

  const handleClearConversations = () => {
    clearAllConversations();
  };

  const handleExportData = () => {
    // Use the proper exportData function which includes all data:
    // conversations, folders, prompts, tones, and custom agents
    exportData();
  };

  const handleImportConversations = (data: any) => {
    try {
      // Use the proper importData function which handles all data types:
      // conversations, folders, prompts, tones, and custom agents
      const result = importData(data);

      // The importData function automatically updates localStorage
      // Force a page reload to ensure all stores pick up the new data
      window.location.reload();
    } catch (error) {
      console.error('Failed to import data:', error);
      alert(
        `Failed to import data: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  };

  const checkStorage = useCallback(() => {
    setStorageData(getStorageUsage());
  }, []);

  // Render nothing if not open
  if (!isSettingsOpen) {
    return null;
  }

  // Create homeState object for compatibility with sections
  const homeState = {
    conversations,
    prompts,
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-gray-950/60 backdrop-blur-sm z-50 animate-fade-in-fast">
      <div className="fixed inset-0 z-10 overflow-hidden">
        <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
          <div
            className="hidden sm:inline-block sm:h-screen sm:align-middle"
            aria-hidden="true"
          />

          <div
            ref={modalRef}
            className="inline-block transform rounded-lg border border-gray-300 bg-white text-left align-bottom shadow-xl dark:border-gray-700 dark:bg-[#171717] sm:my-8 w-full md:max-w-[800px] lg:max-w-[900px] xl:max-w-[1000px] sm:align-middle animate-modal-in"
            role="dialog"
          >
            <div className="flex flex-col md:flex-row h-[550px] md:h-[700px]">
              {/* Navigation sidebar - hidden on mobile */}
              <SettingsSidebar
                activeSection={activeSection}
                setActiveSection={setActiveSection}
                handleReset={handleReset}
                onClose={() => setIsSettingsOpen(false)}
                user={session?.user}
                state={state}
                dispatch={dispatch}
              />

              {/* Content area */}
              <div className="flex-grow overflow-y-auto relative">
                {/* Mobile header */}
                {isMobileView && (
                  <MobileSettingsHeader
                    activeSection={activeSection}
                    setActiveSection={setActiveSection}
                  />
                )}

                {/* Section content */}
                {activeSection === SettingsSection.GENERAL && (
                  <GeneralSection
                    state={state}
                    dispatch={dispatch}
                    user={session?.user}
                    onClose={() => setIsSettingsOpen(false)}
                    prefetchedProfile={fullProfile}
                  />
                )}

                {activeSection === SettingsSection.CHAT_SETTINGS && (
                  <ChatSettingsSection
                    state={state}
                    dispatch={dispatch}
                    homeState={homeState}
                    user={session?.user}
                    onClose={() => setIsSettingsOpen(false)}
                  />
                )}

                {activeSection === SettingsSection.DATA_MANAGEMENT && (
                  <DataManagementSection
                    handleClearConversations={handleClearConversations}
                    handleImportConversations={handleImportConversations}
                    handleExportData={handleExportData}
                    handleReset={handleReset}
                    onClose={() => setIsSettingsOpen(false)}
                    checkStorage={checkStorage}
                    onOpenMigration={() => setShowMigrationDialog(true)}
                    onOpenQuarantine={() => setShowQuarantineDialog(true)}
                  />
                )}

                {activeSection === SettingsSection.MOBILE_APP && (
                  <MobileAppSection />
                )}

                {activeSection === SettingsSection.HELP_SUPPORT && (
                  <HelpSupportSection />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Migration Dialog - opened from Data Management section */}
      <MigrationDialog
        isOpen={showMigrationDialog}
        onComplete={() => setShowMigrationDialog(false)}
      />

      {/* Quarantine Dialog - opened from Data Management section */}
      <QuarantineDialog
        isOpen={showQuarantineDialog}
        onClose={() => setShowQuarantineDialog(false)}
      />
    </div>
  );
}
