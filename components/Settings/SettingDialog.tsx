'use client';

import { useFlags } from 'launchdarkly-react-client-sdk';
import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useForeignConversationImport } from '@/client/hooks/conversation/useForeignConversationImport';
import { useSettings } from '@/client/hooks/settings/useSettings';
import { useCreateReducer } from '@/client/hooks/ui/useCreateReducer';
import { useUI } from '@/client/hooks/ui/useUI';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import { exportData, importData } from '@/lib/utils/app/export/importExport';
import { getSettings, saveSettings } from '@/lib/utils/app/settings';
import { getStorageUsage } from '@/lib/utils/app/storage/storageMonitor';

import { SearchMode } from '@/types/searchMode';
import { DEFAULT_STREAMING_SPEED, Settings } from '@/types/settings';

import { ForeignConversationImportModal } from '@/components/Import/ForeignConversationImportModal';

import packageJson from '../../package.json';
import { MigrationDialog } from '../Migration/MigrationDialog';
import { MobileSettingsHeader } from './MobileSettingsHeader';
import { BackupSection } from './Sections/BackupSection';
import { ChatSettingsSection } from './Sections/ChatSettingsSection';
import { ConnectionsSection } from './Sections/ConnectionsSection';
import { ConnectorsSection } from './Sections/ConnectorsSection';
import { DataManagementSection } from './Sections/DataManagementSection';
import { GeneralSection } from './Sections/GeneralSection';
import { HelpSupportSection } from './Sections/HelpSupportSection';
import { LocalModelsSection } from './Sections/LocalModelsSection';
import { MemoriesSection } from './Sections/MemoriesSection';
import { MobileAppSection } from './Sections/MobileAppSection';
import { UsageImpactSection } from './Sections/UsageImpactSection';
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
  // "Import Backup" also accepts ChatGPT / Claude conversations.json files;
  // those open a picker instead of running the full-backup merge.
  const foreignImport = useForeignConversationImport();
  const [fullProfile, setFullProfile] = useState<any>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    SettingsSection.GENERAL,
  );
  const [isMobileView, setIsMobileView] = useState<boolean>(false);
  // Merged-pane gating (mirrors useSettingsNav's polarity exactly): the
  // Connections pane shows whichever blocks are allowed; Data & Backup
  // embeds the cloud-backup controls only when served `true` (fail-closed).
  const { mcpConnectors, enableEncryptedBackups } = useFlags();
  const mcpConnectorsEnabled = mcpConnectors !== false;
  const encryptedBackupsEnabled = enableEncryptedBackups === true;
  const { filesEnabled: m365Files, mailEnabled: m365Mail } = useM365Enabled();
  const m365ConnectionsEnabled = m365Files || m365Mail;
  const [showMigrationDialog, setShowMigrationDialog] = useState(false);

  // Load settings and storage on client side only
  useEffect(() => {
    const loadedSettings = getSettings();
    Object.keys(loadedSettings).forEach((key) => {
      dispatch({
        field: key as keyof Settings,
        value: loadedSettings[key as keyof Settings],
      });
    });
    setStorageData(getStorageUsage());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      // Don't close if MigrationDialog is open - it's rendered outside modalRef
      if (showMigrationDialog) return;

      // Portaled children of this dialog (the mobile nav sheet and its scrim)
      // live on document.body, so `modalRef.contains` reads them as "outside"
      // and would close the whole dialog mid-interaction — taking the button
      // with it before its click handler could run. They opt out by marking
      // themselves instead.
      if ((e.target as Element)?.closest?.('[data-settings-portal]')) return;

      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        window.addEventListener('mouseup', handleMouseUp);
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      window.removeEventListener('mouseup', handleMouseUp);
      setIsSettingsOpen(false);
    };

    if (isSettingsOpen) {
      window.addEventListener('mousedown', handleMouseDown);
    }

    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isSettingsOpen, setIsSettingsOpen, showMigrationDialog]);

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

  const handleSave = () => {
    setTheme(state.theme);
    setTemperature(state.temperature);
    setSystemPrompt(state.systemPrompt);
    saveSettings(state);
  };

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
    if (foreignImport.offer(data)) return;
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
    <div className="fixed inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50 animate-fade-in-fast">
      <div className="fixed inset-0 z-10 overflow-hidden">
        <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
          <div
            className="hidden sm:inline-block sm:h-screen sm:align-middle"
            aria-hidden="true"
          />

          <div
            ref={modalRef}
            className="dark:border-netural-400 inline-block transform rounded-lg border border-gray-300 bg-white text-left align-bottom shadow-xl transition-all dark:bg-surface-dark-base sm:my-8 w-full md:max-w-[800px] lg:max-w-[900px] xl:max-w-[1000px] sm:align-middle animate-modal-in"
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
                    handleReset={handleReset}
                    onClose={() => setIsSettingsOpen(false)}
                  />
                )}

                {/* Section content */}
                {activeSection === SettingsSection.GENERAL && (
                  <GeneralSection
                    state={state}
                    dispatch={dispatch}
                    user={session?.user}
                    onSave={handleSave}
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
                    onSave={handleSave}
                    onClose={() => setIsSettingsOpen(false)}
                  />
                )}

                {/* One pane for everything the user connects: the M365
                    account block and the MCP connectors block, each behind
                    its own flag (the nav entry shows when either allows). */}
                {activeSection === SettingsSection.CONNECTIONS && (
                  <>
                    {m365ConnectionsEnabled && <ConnectionsSection />}
                    {mcpConnectorsEnabled && <ConnectorsSection />}
                  </>
                )}

                {activeSection === SettingsSection.USAGE_IMPACT && (
                  <UsageImpactSection />
                )}

                {activeSection === SettingsSection.MEMORIES && (
                  <MemoriesSection />
                )}

                {activeSection === SettingsSection.LOCAL_MODELS && (
                  <LocalModelsSection />
                )}

                {/* "Data & Backup": the cloud-backup controls sit on top of
                    the local-data tools when the flag allows, so one pane
                    owns every answer to "where is my data". */}
                {activeSection === SettingsSection.DATA_MANAGEMENT && (
                  <>
                    {encryptedBackupsEnabled && <BackupSection />}
                    <DataManagementSection
                      handleClearConversations={handleClearConversations}
                      handleImportConversations={handleImportConversations}
                      handleExportData={handleExportData}
                      handleReset={handleReset}
                      onClose={() => setIsSettingsOpen(false)}
                      checkStorage={checkStorage}
                      onOpenMigration={() => setShowMigrationDialog(true)}
                    />
                  </>
                )}

                {activeSection === SettingsSection.HELP_SUPPORT && (
                  <>
                    <HelpSupportSection />
                    <MobileAppSection />
                  </>
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

      {/* Picker for ChatGPT / Claude exports dropped on "Import Backup" */}
      <ForeignConversationImportModal
        isOpen={foreignImport.pending !== null}
        detection={foreignImport.pending}
        existingIds={foreignImport.existingIds}
        onClose={foreignImport.close}
        onImport={foreignImport.commit}
      />
    </div>
  );
}
