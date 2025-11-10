/**
 * Type-safe localStorage wrapper with versioning and migration support
 */

export enum StorageKeys {
  CONVERSATIONS = 'conversations',
  FOLDERS = 'folders',
  SELECTED_CONVERSATION_ID = 'selectedConversationId',
  TEMPERATURE = 'temperature',
  SYSTEM_PROMPT = 'systemPrompt',
  PROMPTS = 'prompts',
  THEME = 'theme',
  SHOW_CHATBAR = 'showChatbar',
  SHOW_PROMPT_BAR = 'showPromptbar',
  DEFAULT_MODEL_ID = 'defaultModelId',
  MODELS = 'models',
  CUSTOM_AGENTS = 'customAgents',
}

export class LocalStorageService {
  private static STORAGE_VERSION = 'v2.0';

  /**
   * Get a value from localStorage with type safety
   */
  static get<T>(key: StorageKeys | string): T | null {
    if (typeof window === 'undefined') return null;

    try {
      const item = window.localStorage.getItem(key);
      if (item === null) return null;

      return JSON.parse(item) as T;
    } catch (error) {
      console.error(`Error reading from localStorage key "${key}":`, error);
      console.error(`Raw value: "${window.localStorage.getItem(key)}"`);
      console.warn(`Removing corrupted localStorage key "${key}"`);
      window.localStorage.removeItem(key);
      return null;
    }
  }

  /**
   * Set a value in localStorage
   */
  static set<T>(key: StorageKeys | string, value: T): void {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      console.error(`Error writing to localStorage key "${key}":`, error);
    }
  }

  /**
   * Remove a value from localStorage
   */
  static remove(key: StorageKeys | string): void {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      console.error(`Error removing localStorage key "${key}":`, error);
    }
  }

  /**
   * Clear all localStorage
   */
  static clear(): void {
    if (typeof window === 'undefined') return;

    try {
      window.localStorage.clear();
    } catch (error) {
      console.error('Error clearing localStorage:', error);
    }
  }

  /**
   * Check if a key exists in localStorage
   */
  static has(key: StorageKeys | string): boolean {
    if (typeof window === 'undefined') return false;

    return window.localStorage.getItem(key) !== null;
  }

  /**
   * Get all keys from localStorage
   */
  static getAllKeys(): string[] {
    if (typeof window === 'undefined') return [];

    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key !== null) {
        keys.push(key);
      }
    }
    return keys;
  }

  /**
   * Export all data from localStorage
   */
  static exportData(): Record<string, unknown> {
    if (typeof window === 'undefined') return {};

    const data: Record<string, unknown> = {};
    const keys = this.getAllKeys();

    keys.forEach((key) => {
      const value = this.get(key);
      if (value !== null) {
        data[key] = value;
      }
    });

    return data;
  }

  /**
   * Import data into localStorage
   */
  static importData(data: Record<string, unknown>): void {
    if (typeof window === 'undefined') return;

    Object.entries(data).forEach(([key, value]) => {
      this.set(key, value);
    });
  }

  /**
   * Migrate from legacy localStorage format to Zustand persist stores
   *
   * SAFE MIGRATION STRATEGY:
   * - Copies old data to new format (never deletes old data)
   * - Creates permanent backup
   * - Skips if already migrated
   * - Skips if target already has data (don't overwrite)
   * - Old data remains forever (zero risk of data loss)
   */
  static migrateFromLegacy(): {
    success: boolean;
    errors: string[];
    skipped?: boolean;
  } {
    if (typeof window === 'undefined') {
      return { success: false, errors: ['Cannot run migration on server'] };
    }

    const errors: string[] = [];

    try {
      // Check if already migrated
      const migrationFlag = localStorage.getItem('data_migration_v2_complete');
      if (migrationFlag === 'true') {
        return { success: true, errors: [], skipped: true };
      }

      console.log('🔄 Starting automatic data migration...');

      // Create permanent backup before migration
      try {
        const backupData = {
          timestamp: Date.now(),
          date: new Date().toISOString(),
          data: this.exportData(),
        };
        localStorage.setItem(
          'data_migration_backup',
          JSON.stringify(backupData),
        );
        console.log('✓ Backup created');
      } catch (error) {
        console.warn('Could not create backup:', error);
        // Continue anyway - old data will remain untouched
      }

      // Migrate Settings Store
      try {
        const existingSettings = localStorage.getItem('settings-storage');

        if (existingSettings) {
          console.log('✓ Settings already in new format, skipping');
        } else {
          // Read old format
          const oldTemperature = this.get<number>(StorageKeys.TEMPERATURE);
          const oldSystemPrompt = this.get<string>(StorageKeys.SYSTEM_PROMPT);
          const oldPrompts = this.get<any[]>(StorageKeys.PROMPTS);
          const oldDefaultModelId = this.get<string>(
            StorageKeys.DEFAULT_MODEL_ID,
          );
          const oldCustomAgents = this.get<any[]>(StorageKeys.CUSTOM_AGENTS);

          // Check if there's anything to migrate
          const hasOldData =
            oldTemperature !== null ||
            oldSystemPrompt !== null ||
            oldPrompts !== null ||
            oldDefaultModelId !== null ||
            oldCustomAgents !== null;

          if (hasOldData) {
            // Create new Zustand format with CORRECT version
            // IMPORTANT: Only include fields in partialize
            // NOTE: models is NOT persisted - it's populated dynamically in AppInitializer
            const settingsData = {
              state: {
                temperature: oldTemperature ?? 0.5,
                systemPrompt: oldSystemPrompt ?? '',
                defaultModelId: oldDefaultModelId ?? undefined,
                prompts: oldPrompts ?? [],
                customAgents: oldCustomAgents ?? [],
              },
              version: 1, // CORRECT: Match Zustand persist version
            };

            localStorage.setItem(
              'settings-storage',
              JSON.stringify(settingsData),
            );
            console.log('✓ Settings migrated');
          } else {
            console.log('✓ No old settings data to migrate');
          }
        }
      } catch (error) {
        const msg = `Settings migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
        errors.push(msg);
        console.error(msg);
      }

      // Migrate Conversation Store
      try {
        const existingConversations = localStorage.getItem(
          'conversation-storage',
        );

        if (existingConversations) {
          console.log('✓ Conversations already in new format, skipping');
        } else {
          // Read old format (try both possible keys)
          const oldConversations =
            this.get<any[]>(StorageKeys.CONVERSATIONS) ||
            this.get<any[]>('conversationHistory');
          const oldFolders = this.get<any[]>(StorageKeys.FOLDERS);
          const oldSelectedId = this.get<string>(
            StorageKeys.SELECTED_CONVERSATION_ID,
          );

          const hasOldData =
            oldConversations !== null ||
            oldFolders !== null ||
            oldSelectedId !== null;

          if (hasOldData) {
            // Create new Zustand format with CORRECT version
            // IMPORTANT: Only include fields in partialize (conversations, folders, selectedConversationId)
            const conversationData = {
              state: {
                conversations: oldConversations ?? [],
                folders: oldFolders ?? [],
                selectedConversationId: oldSelectedId ?? null,
              },
              version: 1, // CORRECT: Match Zustand persist version
            };

            localStorage.setItem(
              'conversation-storage',
              JSON.stringify(conversationData),
            );

            if (oldConversations && oldConversations.length > 0) {
              console.log(
                `✓ Migrated ${oldConversations.length} conversations`,
              );
            } else {
              console.log('✓ Conversations migrated');
            }
          } else {
            console.log('✓ No old conversation data to migrate');
          }
        }
      } catch (error) {
        const msg = `Conversation migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
        errors.push(msg);
        console.error(msg);
      }

      // Migrate UI Store
      try {
        const existingUI = localStorage.getItem('ui-storage');

        if (existingUI) {
          console.log('✓ UI settings already in new format, skipping');
        } else {
          // Read old format
          const oldTheme = this.get<string>(StorageKeys.THEME);
          const oldShowChatbar = this.get<boolean>(StorageKeys.SHOW_CHATBAR);
          const oldShowPromptbar = this.get<boolean>(
            StorageKeys.SHOW_PROMPT_BAR,
          );

          const hasOldData =
            oldTheme !== null ||
            oldShowChatbar !== null ||
            oldShowPromptbar !== null;

          if (hasOldData) {
            // Create new Zustand format with CORRECT version
            // IMPORTANT: Only include fields in partialize (theme, showChatbar, showPromptbar)
            // Use correct defaults from uiStore.ts
            const uiData = {
              state: {
                theme: oldTheme ?? 'dark', // Default from uiStore
                showChatbar: oldShowChatbar ?? false, // Default from uiStore
                showPromptbar: oldShowPromptbar ?? true, // Default from uiStore
              },
              version: 1, // CORRECT: Match Zustand persist version
            };

            localStorage.setItem('ui-storage', JSON.stringify(uiData));
            console.log('✓ UI settings migrated');
          } else {
            console.log('✓ No old UI data to migrate');
          }
        }
      } catch (error) {
        const msg = `UI migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
        errors.push(msg);
        console.error(msg);
      }

      // Mark migration as complete ONLY if successful
      if (errors.length === 0) {
        localStorage.setItem('data_migration_v2_complete', 'true');
        console.log(
          '✅ Migration complete! Old data preserved in localStorage.',
        );
        console.log(
          '💡 Tip: Old data will remain for safety. You can manually clear it in Settings if desired.',
        );
      } else {
        console.error('❌ Migration had errors. Will retry on next load.');
      }

      return { success: errors.length === 0, errors };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      errors.push(errorMessage);
      console.error('❌ Migration failed:', errorMessage);
      return { success: false, errors };
    }
  }

  /**
   * Check if old localStorage data exists that needs migration
   */
  static hasLegacyData(): boolean {
    if (typeof window === 'undefined') return false;

    const migrationFlag = localStorage.getItem('data_migration_v2_complete');
    if (migrationFlag === 'true') return false;

    // Check for any old keys
    const oldKeys = [
      StorageKeys.CONVERSATIONS,
      'conversationHistory',
      StorageKeys.TEMPERATURE,
      StorageKeys.SYSTEM_PROMPT,
      StorageKeys.THEME,
    ];

    return oldKeys.some((key) => this.has(key));
  }
}
