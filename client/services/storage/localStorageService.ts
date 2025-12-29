/**
 * Type-safe localStorage wrapper with versioning and migration support
 */
import {
  LEGACY_STORAGE_KEYS,
  getItemSize,
  getStorageUsage,
  getStringSizeInBytes,
} from '@/lib/utils/app/storage/storageMonitor';

import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import {
  DeleteLegacyResult,
  IncrementalMigrationResult,
  IncrementalProgress,
  LegacyConversation,
  LegacyCustomAgent,
  LegacyPrompt,
  MigrationResult,
  MigrationStats,
  QuotaAnalysis,
  SkippedItem,
  StorageKeys,
} from '@/types/storage';

import { getDefaultModel } from '@/config/models';

// Re-export types for backwards compatibility
export type {
  IncrementalMigrationResult,
  MigrationResult,
  MigrationStats,
  QuotaAnalysis,
} from '@/types/storage';
export { StorageKeys } from '@/types/storage';

/**
 * Validate legacy conversation structure.
 * Logs specific validation failures for debugging.
 */
function isValidLegacyConversation(
  obj: unknown,
  index: number,
): obj is LegacyConversation {
  if (!obj || typeof obj !== 'object') {
    console.warn(`Conversation[${index}]: not an object`);
    return false;
  }
  const c = obj as Record<string, unknown>;
  if (typeof c.id !== 'string') {
    console.warn(`Conversation[${index}]: missing or invalid id`);
    return false;
  }
  if (typeof c.name !== 'string') {
    console.warn(`Conversation[${index}]: missing or invalid name`);
    return false;
  }
  if (!Array.isArray(c.messages)) {
    console.warn(`Conversation[${index}]: missing or invalid messages array`);
    return false;
  }
  return true;
}

/**
 * Validate legacy prompt structure.
 */
function isValidLegacyPrompt(obj: unknown, index: number): obj is LegacyPrompt {
  if (!obj || typeof obj !== 'object') {
    console.warn(`Prompt[${index}]: not an object`);
    return false;
  }
  const p = obj as Record<string, unknown>;
  if (typeof p.id !== 'string') {
    console.warn(`Prompt[${index}]: missing or invalid id`);
    return false;
  }
  if (typeof p.name !== 'string') {
    console.warn(`Prompt[${index}]: missing or invalid name`);
    return false;
  }
  if (typeof p.content !== 'string') {
    console.warn(`Prompt[${index}]: missing or invalid content`);
    return false;
  }
  return true;
}

/**
 * Validate legacy custom agent structure.
 */
function isValidLegacyCustomAgent(
  obj: unknown,
  index: number,
): obj is LegacyCustomAgent {
  if (!obj || typeof obj !== 'object') {
    console.warn(`CustomAgent[${index}]: not an object`);
    return false;
  }
  const a = obj as Record<string, unknown>;
  if (typeof a.id !== 'string') {
    console.warn(`CustomAgent[${index}]: missing or invalid id`);
    return false;
  }
  if (typeof a.name !== 'string') {
    console.warn(`CustomAgent[${index}]: missing or invalid name`);
    return false;
  }
  if (typeof a.agentId !== 'string') {
    console.warn(`CustomAgent[${index}]: missing or invalid agentId`);
    return false;
  }
  return true;
}

// ============================================================================
// Model Validation
// ============================================================================

/**
 * Validate and fix conversation model if it's not available in the current application.
 * If the model doesn't exist or is disabled, replace it with the default model.
 * Also refreshes valid model objects to get latest properties.
 */
function validateAndFixConversationModel(
  conv: LegacyConversation,
  warnings: string[],
): LegacyConversation {
  const modelId = (conv.model as OpenAIModel | undefined)?.id;

  // Check if model exists and is not disabled
  const availableModel = modelId
    ? OpenAIModels[modelId as OpenAIModelID]
    : null;

  if (!availableModel || availableModel.isDisabled) {
    // Get default model
    const defaultModelId = getDefaultModel();
    const defaultModel = OpenAIModels[defaultModelId as OpenAIModelID];

    if (defaultModel) {
      warnings.push(
        `Conversation "${conv.name}": model "${modelId || 'unknown'}" not available, switched to "${defaultModelId}"`,
      );
      return { ...conv, model: defaultModel };
    }

    // Fallback: if even default model is missing, log error but don't fail
    console.error(
      `Default model "${defaultModelId}" not found in OpenAIModels`,
    );
    return conv;
  }

  // Model is valid - refresh the model object to get latest properties
  return { ...conv, model: availableModel };
}

// ============================================================================
// Merge Functions
// ============================================================================

/**
 * Check if two conversations are "the same" based on name and first few messages.
 */
function conversationsAreSame(
  a: LegacyConversation,
  b: LegacyConversation,
): boolean {
  if (a.name !== b.name) return false;
  const aMessages = a.messages as Array<{ content?: string }>;
  const bMessages = b.messages as Array<{ content?: string }>;
  const minLen = Math.min(aMessages.length, bMessages.length, 3);
  for (let i = 0; i < minLen; i++) {
    if (aMessages[i]?.content !== bMessages[i]?.content) return false;
  }
  return true;
}

/**
 * Smart merge conversations: handles collisions by comparing content.
 * - No collision: add legacy as-is
 * - Same content: keep longer one
 * - Different content: rename legacy id with '-legacy' suffix
 */
function mergeConversations(
  existing: LegacyConversation[],
  legacy: LegacyConversation[],
): { merged: LegacyConversation[]; addedCount: number; warnings: string[] } {
  const existingMap = new Map(existing.map((c) => [c.id, c]));
  const result = [...existing];
  let addedCount = 0;
  const warnings: string[] = [];

  for (const legacyConv of legacy) {
    // Validate and fix model before merging
    const validatedConv = validateAndFixConversationModel(legacyConv, warnings);

    const existingConv = existingMap.get(validatedConv.id);

    if (!existingConv) {
      // No collision - add as-is
      result.push(validatedConv);
      addedCount++;
    } else if (conversationsAreSame(existingConv, validatedConv)) {
      // Same content - keep longer one
      const existingLen = (existingConv.messages as unknown[]).length;
      const legacyLen = (validatedConv.messages as unknown[]).length;
      if (legacyLen > existingLen) {
        const idx = result.findIndex((c) => c.id === existingConv.id);
        result[idx] = validatedConv;
        warnings.push(
          `Replaced conversation "${validatedConv.name}" with longer version (${legacyLen} vs ${existingLen} messages)`,
        );
      }
      // Not incrementing addedCount - this is a replacement, not an addition
    } else {
      // Different content - rename legacy id and add both
      const newId = `${validatedConv.id}-legacy`;
      result.push({ ...validatedConv, id: newId });
      addedCount++;
      warnings.push(
        `Conversation "${validatedConv.name}" had id collision - renamed to ${newId}`,
      );
    }
  }

  return { merged: result, addedCount, warnings };
}

/**
 * Smart merge for items with id (prompts, agents, folders).
 * Simply deduplicates by id, keeping existing.
 */
function mergeById<T extends { id: string }>(
  existing: T[],
  legacy: T[],
): { merged: T[]; addedCount: number } {
  const existingIds = new Set(existing.map((item) => item.id));
  const newItems = legacy.filter((item) => !existingIds.has(item.id));
  return {
    merged: [...existing, ...newItems],
    addedCount: newItems.length,
  };
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
   * SMART MIGRATION STRATEGY:
   * - Validates legacy data structure before migration
   * - Merges legacy data with existing Zustand data (deduplicates by id)
   * - For conversations with id collision: keeps both if different, keeps longer if same
   * - Creates permanent backup
   * - Reports accurate stats (only counts actually migrated items)
   * - Surfaces errors and warnings for debugging
   *
   * @returns MigrationResult with success status, errors, warnings, and stats
   */
  static migrateFromLegacy(): MigrationResult {
    const emptyStats: MigrationStats = {
      conversations: 0,
      folders: 0,
      prompts: 0,
      customAgents: 0,
    };

    const emptyResult = (
      success: boolean,
      errors: string[] = [],
      skipped = false,
    ): MigrationResult => ({
      success,
      errors,
      warnings: [],
      skipped,
      stats: emptyStats,
    });

    if (typeof window === 'undefined') {
      return emptyResult(false, ['Cannot run migration on server']);
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const stats: MigrationStats = { ...emptyStats };

    try {
      // Check if already migrated
      const migrationFlag = localStorage.getItem('data_migration_v2_complete');
      if (migrationFlag === 'true') {
        return { ...emptyResult(true, [], true) };
      }

      console.log('🔄 Starting data migration...');

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
        warnings.push(
          `Could not create backup: ${error instanceof Error ? error.message : 'Unknown'}`,
        );
      }

      // ========================================================================
      // Migrate Conversations
      // ========================================================================
      try {
        // Read existing Zustand data
        const existingConvStorage = localStorage.getItem(
          'conversation-storage',
        );
        const existingConvData = existingConvStorage
          ? JSON.parse(existingConvStorage)
          : null;
        const existingConvs: LegacyConversation[] =
          existingConvData?.state?.conversations ?? [];
        const existingFolders: Array<{ id: string }> =
          existingConvData?.state?.folders ?? [];

        // Read legacy data (try both possible keys)
        const rawLegacyConvs =
          this.get<unknown[]>('conversationHistory') ||
          this.get<unknown[]>(StorageKeys.CONVERSATIONS);
        const rawLegacyFolders = this.get<unknown[]>(StorageKeys.FOLDERS);
        const oldSelectedId = this.get<string>(
          StorageKeys.SELECTED_CONVERSATION_ID,
        );

        // Validate and filter legacy conversations
        const validLegacyConvs: LegacyConversation[] = [];
        if (rawLegacyConvs && Array.isArray(rawLegacyConvs)) {
          for (let i = 0; i < rawLegacyConvs.length; i++) {
            if (isValidLegacyConversation(rawLegacyConvs[i], i)) {
              validLegacyConvs.push(rawLegacyConvs[i] as LegacyConversation);
            } else {
              errors.push(
                `Invalid conversation at index ${i}: ${JSON.stringify(rawLegacyConvs[i]).slice(0, 100)}...`,
              );
            }
          }
        }

        // Validate legacy folders
        const validLegacyFolders: Array<{ id: string; name: string }> = [];
        if (rawLegacyFolders && Array.isArray(rawLegacyFolders)) {
          for (const folder of rawLegacyFolders) {
            if (
              folder &&
              typeof folder === 'object' &&
              typeof (folder as Record<string, unknown>).id === 'string'
            ) {
              validLegacyFolders.push(folder as { id: string; name: string });
            }
          }
        }

        // Smart merge conversations
        if (validLegacyConvs.length > 0) {
          const mergeResult = mergeConversations(
            existingConvs,
            validLegacyConvs,
          );
          stats.conversations = mergeResult.addedCount;
          warnings.push(...mergeResult.warnings);

          // Merge folders by id
          const folderMerge = mergeById(existingFolders, validLegacyFolders);
          stats.folders = folderMerge.addedCount;

          // Write merged data
          const conversationData = {
            state: {
              conversations: mergeResult.merged,
              folders: folderMerge.merged,
              selectedConversationId:
                existingConvData?.state?.selectedConversationId ??
                oldSelectedId ??
                null,
            },
            version: 1,
          };

          localStorage.setItem(
            'conversation-storage',
            JSON.stringify(conversationData),
          );
          console.log(
            `✓ Conversations: merged ${validLegacyConvs.length} legacy into ${existingConvs.length} existing (${stats.conversations} new)`,
          );
        } else if (rawLegacyConvs) {
          warnings.push(
            `Found ${rawLegacyConvs.length} legacy conversations but none were valid`,
          );
        }
      } catch (error) {
        const msg = `Conversation migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
        errors.push(msg);
        console.error(msg);
      }

      // ========================================================================
      // Migrate Settings (prompts, customAgents)
      // ========================================================================
      try {
        // Read existing Zustand data
        const existingSettingsStorage =
          localStorage.getItem('settings-storage');
        const existingSettingsData = existingSettingsStorage
          ? JSON.parse(existingSettingsStorage)
          : null;
        const existingPrompts: LegacyPrompt[] =
          existingSettingsData?.state?.prompts ?? [];
        const existingAgents: LegacyCustomAgent[] =
          existingSettingsData?.state?.customAgents ?? [];

        // Read legacy data
        const oldTemperature = this.get<number>(StorageKeys.TEMPERATURE);
        const oldSystemPrompt = this.get<string>(StorageKeys.SYSTEM_PROMPT);
        const rawLegacyPrompts = this.get<unknown[]>(StorageKeys.PROMPTS);
        const oldDefaultModelId = this.get<string>(
          StorageKeys.DEFAULT_MODEL_ID,
        );
        const rawLegacyAgents = this.get<unknown[]>(StorageKeys.CUSTOM_AGENTS);

        // Validate legacy prompts
        const validLegacyPrompts: LegacyPrompt[] = [];
        if (rawLegacyPrompts && Array.isArray(rawLegacyPrompts)) {
          for (let i = 0; i < rawLegacyPrompts.length; i++) {
            if (isValidLegacyPrompt(rawLegacyPrompts[i], i)) {
              validLegacyPrompts.push(rawLegacyPrompts[i] as LegacyPrompt);
            } else {
              errors.push(
                `Invalid prompt at index ${i}: ${JSON.stringify(rawLegacyPrompts[i]).slice(0, 100)}...`,
              );
            }
          }
        }

        // Validate legacy custom agents
        const validLegacyAgents: LegacyCustomAgent[] = [];
        if (rawLegacyAgents && Array.isArray(rawLegacyAgents)) {
          for (let i = 0; i < rawLegacyAgents.length; i++) {
            if (isValidLegacyCustomAgent(rawLegacyAgents[i], i)) {
              validLegacyAgents.push(rawLegacyAgents[i] as LegacyCustomAgent);
            } else {
              errors.push(
                `Invalid custom agent at index ${i}: ${JSON.stringify(rawLegacyAgents[i]).slice(0, 100)}...`,
              );
            }
          }
        }

        // Merge prompts and agents
        const promptMerge = mergeById(existingPrompts, validLegacyPrompts);
        const agentMerge = mergeById(existingAgents, validLegacyAgents);
        stats.prompts = promptMerge.addedCount;
        stats.customAgents = agentMerge.addedCount;

        // Check if we have anything to write
        const hasLegacySettings =
          oldTemperature !== null ||
          oldSystemPrompt !== null ||
          validLegacyPrompts.length > 0 ||
          oldDefaultModelId !== null ||
          validLegacyAgents.length > 0;

        if (hasLegacySettings || existingSettingsData) {
          const baseState = existingSettingsData?.state ?? {};
          const settingsData = {
            state: {
              ...baseState,
              temperature: oldTemperature ?? baseState.temperature ?? 0.5,
              systemPrompt: oldSystemPrompt ?? baseState.systemPrompt ?? '',
              defaultModelId:
                oldDefaultModelId ?? baseState.defaultModelId ?? undefined,
              defaultSearchMode: baseState.defaultSearchMode ?? 'intelligent',
              prompts: promptMerge.merged,
              tones: baseState.tones ?? [],
              customAgents: agentMerge.merged,
            },
            version: 2,
          };

          localStorage.setItem(
            'settings-storage',
            JSON.stringify(settingsData),
          );
          console.log(
            `✓ Settings: ${stats.prompts} prompts, ${stats.customAgents} agents migrated`,
          );
        }
      } catch (error) {
        const msg = `Settings migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
        errors.push(msg);
        console.error(msg);
      }

      // NOTE: UI preferences are stored in cookies via UIPreferencesProvider,
      // not in localStorage. No migration needed.

      // Mark migration as complete ONLY if no critical errors
      if (errors.length === 0) {
        localStorage.setItem('data_migration_v2_complete', 'true');
        console.log('✅ Migration complete!');
      } else {
        console.error(`❌ Migration had ${errors.length} errors:`, errors);
      }

      if (warnings.length > 0) {
        console.warn(`⚠️ Migration warnings:`, warnings);
      }

      return {
        success: errors.length === 0,
        errors,
        warnings,
        skipped: false,
        stats,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      errors.push(errorMessage);
      console.error('❌ Migration failed:', errorMessage);
      return { success: false, errors, warnings, skipped: false, stats };
    }
  }

  /**
   * Check if old localStorage data exists that needs migration
   */
  static hasLegacyData(): boolean {
    if (typeof window === 'undefined') return false;

    const migrationFlag = localStorage.getItem('data_migration_v2_complete');
    if (migrationFlag === 'true') return false;

    // Check for any old keys that need migration
    // NOTE: THEME is not included because UI prefs are stored in cookies, not localStorage
    const oldKeys = [
      StorageKeys.CONVERSATIONS,
      'conversationHistory',
      StorageKeys.TEMPERATURE,
      StorageKeys.SYSTEM_PROMPT,
      StorageKeys.PROMPTS,
      StorageKeys.CUSTOM_AGENTS,
    ];

    return oldKeys.some((key) => this.has(key));
  }

  // ==========================================================================
  // Quota Analysis and Incremental Migration
  // ==========================================================================

  /** Legacy keys that contain data to be migrated */
  private static readonly LEGACY_KEYS = [
    'conversationHistory',
    StorageKeys.CONVERSATIONS,
    StorageKeys.PROMPTS,
    StorageKeys.CUSTOM_AGENTS,
    StorageKeys.FOLDERS,
    StorageKeys.TEMPERATURE,
    StorageKeys.SYSTEM_PROMPT,
    StorageKeys.DEFAULT_MODEL_ID,
  ];

  /**
   * Analyze storage quota to determine if migration would exceed limits.
   * Call this before migration to decide if incremental mode is needed.
   *
   * @returns QuotaAnalysis with current usage, estimated merged size, and deficit
   */
  static analyzeQuotaForMigration(): QuotaAnalysis {
    if (typeof window === 'undefined') {
      return {
        currentUsage: 0,
        maxUsage: 5 * 1024 * 1024,
        legacySize: 0,
        estimatedMergedSize: 0,
        availableSpace: 5 * 1024 * 1024,
        wouldExceedQuota: false,
        deficit: 0,
      };
    }

    const { currentUsage, maxUsage } = getStorageUsage();

    // Calculate total size of legacy data
    let legacySize = 0;
    for (const key of this.LEGACY_KEYS) {
      legacySize += getItemSize(key);
    }

    // Calculate size of existing Zustand stores
    const conversationStorageSize = getItemSize('conversation-storage');
    const settingsStorageSize = getItemSize('settings-storage');

    // Estimate merged size: existing Zustand + legacy data
    // This is a conservative estimate - actual merged size may be smaller
    // due to deduplication, but we err on the side of caution
    const estimatedMergedSize =
      conversationStorageSize + settingsStorageSize + legacySize;

    // Calculate available space and deficit
    const availableSpace = maxUsage - currentUsage;
    const wouldExceedQuota = estimatedMergedSize > maxUsage;
    const deficit = Math.max(0, estimatedMergedSize - maxUsage);

    return {
      currentUsage,
      maxUsage,
      legacySize,
      estimatedMergedSize,
      availableSpace,
      wouldExceedQuota,
      deficit,
    };
  }

  /**
   * Remove a single conversation from legacy storage.
   * Used during incremental migration after successful migration.
   */
  private static removeLegacyConversation(id: string): void {
    // Try conversationHistory key first (primary legacy key)
    const legacyConvs =
      this.get<LegacyConversation[]>('conversationHistory') || [];
    const filtered = legacyConvs.filter((c) => c.id !== id);

    if (filtered.length === 0) {
      this.remove('conversationHistory');
    } else if (filtered.length < legacyConvs.length) {
      this.set('conversationHistory', filtered);
    }

    // Also check the old conversations key
    const oldConvs =
      this.get<LegacyConversation[]>(StorageKeys.CONVERSATIONS) || [];
    const filteredOld = oldConvs.filter((c) => c.id !== id);

    if (filteredOld.length === 0) {
      this.remove(StorageKeys.CONVERSATIONS);
    } else if (filteredOld.length < oldConvs.length) {
      this.set(StorageKeys.CONVERSATIONS, filteredOld);
    }
  }

  /**
   * Migrate a single conversation to Zustand storage.
   * Handles merging with existing conversations.
   */
  private static migrateSingleConversation(
    conv: LegacyConversation,
    warnings: string[],
  ): void {
    // Read current Zustand state
    const existingStorage = localStorage.getItem('conversation-storage');
    const existingData = existingStorage ? JSON.parse(existingStorage) : null;
    const existingConvs: LegacyConversation[] =
      existingData?.state?.conversations ?? [];
    const existingFolders = existingData?.state?.folders ?? [];

    // Validate and fix model
    const validatedConv = validateAndFixConversationModel(conv, warnings);

    // Check for collision
    const existingConv = existingConvs.find((c) => c.id === validatedConv.id);
    let updatedConvs: LegacyConversation[];

    if (!existingConv) {
      // No collision - add as-is
      updatedConvs = [...existingConvs, validatedConv];
    } else if (conversationsAreSame(existingConv, validatedConv)) {
      // Same content - keep longer one
      const existingLen = (existingConv.messages as unknown[]).length;
      const legacyLen = (validatedConv.messages as unknown[]).length;
      if (legacyLen > existingLen) {
        updatedConvs = existingConvs.map((c) =>
          c.id === existingConv.id ? validatedConv : c,
        );
        warnings.push(
          `Replaced "${validatedConv.name}" with longer version (${legacyLen} vs ${existingLen} messages)`,
        );
      } else {
        updatedConvs = existingConvs; // Keep existing
      }
    } else {
      // Different content - rename legacy id and add both
      const newId = `${validatedConv.id}-legacy`;
      updatedConvs = [...existingConvs, { ...validatedConv, id: newId }];
      warnings.push(
        `"${validatedConv.name}" renamed to ${newId} (id collision)`,
      );
    }

    // Write back to Zustand storage
    const conversationData = {
      state: {
        conversations: updatedConvs,
        folders: existingFolders,
        selectedConversationId: existingData?.state?.selectedConversationId,
      },
      version: 1,
    };

    localStorage.setItem(
      'conversation-storage',
      JSON.stringify(conversationData),
    );
  }

  /**
   * Migrate data incrementally, processing one item at a time.
   * Deletes legacy data as it's migrated to free up space.
   * Prioritizes newest conversations first.
   *
   * @param onProgress - Optional callback for progress updates
   * @returns IncrementalMigrationResult with skipped items info
   */
  static migrateIncrementally(
    onProgress?: (progress: IncrementalProgress) => void,
  ): IncrementalMigrationResult {
    const emptyStats: MigrationStats = {
      conversations: 0,
      folders: 0,
      prompts: 0,
      customAgents: 0,
    };

    if (typeof window === 'undefined') {
      return {
        success: false,
        errors: ['Cannot run migration on server'],
        warnings: [],
        skipped: false,
        stats: emptyStats,
        skippedItems: [],
        hasSkippedItems: false,
      };
    }

    const errors: string[] = [];
    const warnings: string[] = [];
    const stats: MigrationStats = { ...emptyStats };
    const skippedItems: SkippedItem[] = [];
    let bytesFreed = 0;

    console.log('🔄 Starting incremental migration...');

    // ========================================================================
    // Phase 1: Migrate Conversations (one at a time, newest first)
    // ========================================================================
    try {
      const rawLegacyConvs =
        this.get<LegacyConversation[]>('conversationHistory') ||
        this.get<LegacyConversation[]>(StorageKeys.CONVERSATIONS) ||
        [];

      // Validate conversations
      const validConvs: LegacyConversation[] = [];
      for (let i = 0; i < rawLegacyConvs.length; i++) {
        if (isValidLegacyConversation(rawLegacyConvs[i], i)) {
          validConvs.push(rawLegacyConvs[i]);
        } else {
          errors.push(
            `Invalid conversation at index ${i}: ${JSON.stringify(rawLegacyConvs[i]).slice(0, 100)}...`,
          );
        }
      }

      // Sort by date, NEWEST FIRST (descending)
      const sortedConvs = [...validConvs].sort((a, b) => {
        const dateA = new Date(
          (a.updatedAt as string) || (a.createdAt as string) || 0,
        ).getTime();
        const dateB = new Date(
          (b.updatedAt as string) || (b.createdAt as string) || 0,
        ).getTime();
        return dateB - dateA; // Descending - newest first
      });

      for (let i = 0; i < sortedConvs.length; i++) {
        const conv = sortedConvs[i];
        onProgress?.({
          phase: 'conversations',
          current: i + 1,
          total: sortedConvs.length,
          bytesFreed,
        });

        const convSize = getStringSizeInBytes(JSON.stringify(conv));
        const { currentUsage, maxUsage } = getStorageUsage();
        const availableSpace = maxUsage - currentUsage;

        // Check if this conversation would fit
        // We need some buffer for the Zustand wrapper overhead
        const requiredSpace = convSize + 500; // 500 bytes buffer for wrapper

        if (requiredSpace > availableSpace) {
          skippedItems.push({
            id: conv.id,
            name: conv.name,
            type: 'conversation',
            size: convSize,
            reason: 'too_large',
          });
          console.warn(
            `⚠️ Skipping "${conv.name}" - too large (${convSize} bytes, only ${availableSpace} available)`,
          );
          continue;
        }

        // Try to migrate this conversation
        try {
          this.migrateSingleConversation(conv, warnings);
          this.removeLegacyConversation(conv.id);
          stats.conversations++;
          bytesFreed += convSize;
        } catch (e) {
          // If write fails (quota), add to skipped
          skippedItems.push({
            id: conv.id,
            name: conv.name,
            type: 'conversation',
            size: convSize,
            reason: 'quota_exceeded',
          });
          console.error(`❌ Failed to migrate "${conv.name}":`, e);
        }
      }

      console.log(`✓ Conversations: ${stats.conversations} migrated`);
    } catch (error) {
      const msg = `Conversation migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
      errors.push(msg);
      console.error(msg);
    }

    // ========================================================================
    // Phase 2: Migrate Prompts (batch - they're small)
    // ========================================================================
    try {
      onProgress?.({
        phase: 'prompts',
        current: 0,
        total: 1,
        bytesFreed,
      });

      const rawLegacyPrompts = this.get<unknown[]>(StorageKeys.PROMPTS) || [];
      const validPrompts: LegacyPrompt[] = [];

      for (let i = 0; i < rawLegacyPrompts.length; i++) {
        if (isValidLegacyPrompt(rawLegacyPrompts[i], i)) {
          validPrompts.push(rawLegacyPrompts[i] as LegacyPrompt);
        }
      }

      if (validPrompts.length > 0) {
        // Read existing settings
        const existingStorage = localStorage.getItem('settings-storage');
        const existingData = existingStorage
          ? JSON.parse(existingStorage)
          : null;
        const existingPrompts: LegacyPrompt[] =
          existingData?.state?.prompts ?? [];

        // Merge prompts
        const promptMerge = mergeById(existingPrompts, validPrompts);
        stats.prompts = promptMerge.addedCount;

        // Update settings storage
        const settingsData = {
          state: {
            ...(existingData?.state ?? {}),
            prompts: promptMerge.merged,
          },
          version: 2,
        };
        localStorage.setItem('settings-storage', JSON.stringify(settingsData));

        // Remove legacy prompts
        this.remove(StorageKeys.PROMPTS);
        console.log(`✓ Prompts: ${stats.prompts} migrated`);
      }
    } catch (error) {
      const msg = `Prompt migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
      errors.push(msg);
      console.error(msg);
    }

    // ========================================================================
    // Phase 3: Migrate Custom Agents (batch - they're small)
    // ========================================================================
    try {
      onProgress?.({
        phase: 'agents',
        current: 0,
        total: 1,
        bytesFreed,
      });

      const rawLegacyAgents =
        this.get<unknown[]>(StorageKeys.CUSTOM_AGENTS) || [];
      const validAgents: LegacyCustomAgent[] = [];

      for (let i = 0; i < rawLegacyAgents.length; i++) {
        if (isValidLegacyCustomAgent(rawLegacyAgents[i], i)) {
          validAgents.push(rawLegacyAgents[i] as LegacyCustomAgent);
        }
      }

      if (validAgents.length > 0) {
        // Read existing settings
        const existingStorage = localStorage.getItem('settings-storage');
        const existingData = existingStorage
          ? JSON.parse(existingStorage)
          : null;
        const existingAgents: LegacyCustomAgent[] =
          existingData?.state?.customAgents ?? [];

        // Merge agents
        const agentMerge = mergeById(existingAgents, validAgents);
        stats.customAgents = agentMerge.addedCount;

        // Update settings storage
        const settingsData = {
          state: {
            ...(existingData?.state ?? {}),
            customAgents: agentMerge.merged,
          },
          version: 2,
        };
        localStorage.setItem('settings-storage', JSON.stringify(settingsData));

        // Remove legacy agents
        this.remove(StorageKeys.CUSTOM_AGENTS);
        console.log(`✓ Custom agents: ${stats.customAgents} migrated`);
      }
    } catch (error) {
      const msg = `Agent migration error: ${error instanceof Error ? error.message : 'Unknown'}`;
      errors.push(msg);
      console.error(msg);
    }

    // ========================================================================
    // Cleanup legacy settings keys
    // ========================================================================
    try {
      const oldTemperature = this.get<number>(StorageKeys.TEMPERATURE);
      const oldSystemPrompt = this.get<string>(StorageKeys.SYSTEM_PROMPT);
      const oldDefaultModelId = this.get<string>(StorageKeys.DEFAULT_MODEL_ID);

      if (
        oldTemperature !== null ||
        oldSystemPrompt !== null ||
        oldDefaultModelId !== null
      ) {
        const existingStorage = localStorage.getItem('settings-storage');
        const existingData = existingStorage
          ? JSON.parse(existingStorage)
          : null;
        const baseState = existingData?.state ?? {};

        const settingsData = {
          state: {
            ...baseState,
            temperature: oldTemperature ?? baseState.temperature ?? 0.5,
            systemPrompt: oldSystemPrompt ?? baseState.systemPrompt ?? '',
            defaultModelId:
              oldDefaultModelId ?? baseState.defaultModelId ?? undefined,
            defaultSearchMode: baseState.defaultSearchMode ?? 'intelligent',
            tones: baseState.tones ?? [],
          },
          version: 2,
        };
        localStorage.setItem('settings-storage', JSON.stringify(settingsData));

        // Remove legacy keys
        this.remove(StorageKeys.TEMPERATURE);
        this.remove(StorageKeys.SYSTEM_PROMPT);
        this.remove(StorageKeys.DEFAULT_MODEL_ID);
      }
    } catch (error) {
      console.warn('Could not migrate legacy settings:', error);
    }

    // Final progress update
    onProgress?.({
      phase: 'complete',
      current: 1,
      total: 1,
      bytesFreed,
    });

    // Mark migration complete only if no critical errors and no skipped items
    const hasSkippedItems = skippedItems.length > 0;
    if (errors.length === 0 && !hasSkippedItems) {
      localStorage.setItem('data_migration_v2_complete', 'true');
      console.log('✅ Incremental migration complete!');
    } else if (hasSkippedItems) {
      console.warn(
        `⚠️ Migration partially complete - ${skippedItems.length} items skipped`,
      );
    } else {
      console.error(`❌ Migration had ${errors.length} errors:`, errors);
    }

    return {
      success: errors.length === 0 && !hasSkippedItems,
      errors,
      warnings,
      skipped: false,
      stats,
      skippedItems,
      hasSkippedItems,
    };
  }

  /**
   * Export only the skipped items that couldn't be migrated.
   * Users can save these to import later after freeing space.
   */
  static exportSkippedItems(skippedItems: SkippedItem[]): {
    conversations: LegacyConversation[];
    prompts: LegacyPrompt[];
    agents: LegacyCustomAgent[];
  } {
    const conversations: LegacyConversation[] = [];
    const prompts: LegacyPrompt[] = [];
    const agents: LegacyCustomAgent[] = [];

    // Get legacy data
    const legacyConvs =
      this.get<LegacyConversation[]>('conversationHistory') ||
      this.get<LegacyConversation[]>(StorageKeys.CONVERSATIONS) ||
      [];
    const legacyPrompts = this.get<LegacyPrompt[]>(StorageKeys.PROMPTS) || [];
    const legacyAgents =
      this.get<LegacyCustomAgent[]>(StorageKeys.CUSTOM_AGENTS) || [];

    // Filter to only skipped items
    for (const item of skippedItems) {
      if (item.type === 'conversation') {
        const conv = legacyConvs.find((c) => c.id === item.id);
        if (conv) conversations.push(conv);
      } else if (item.type === 'prompt') {
        const prompt = legacyPrompts.find((p) => p.id === item.id);
        if (prompt) prompts.push(prompt);
      } else if (item.type === 'agent') {
        const agent = legacyAgents.find((a) => a.id === item.id);
        if (agent) agents.push(agent);
      }
    }

    return { conversations, prompts, agents };
  }

  // ==========================================================================
  // Legacy Data Management
  // ==========================================================================

  /**
   * Export only legacy data for backup before deletion.
   * Downloads a JSON file containing all unmigrated legacy data.
   *
   * @throws Error if no legacy data exists
   */
  static exportLegacyData(): void {
    if (typeof window === 'undefined') {
      throw new Error('Cannot export in server environment');
    }

    const legacyData: Record<string, unknown> = {};

    for (const key of LEGACY_STORAGE_KEYS) {
      const value = localStorage.getItem(key);
      if (value) {
        try {
          legacyData[key] = JSON.parse(value);
        } catch {
          // Store as string if not valid JSON
          legacyData[key] = value;
        }
      }
    }

    if (Object.keys(legacyData).length === 0) {
      throw new Error('No legacy data to export');
    }

    // Create and download the file
    const blob = new Blob([JSON.stringify(legacyData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = `legacy_data_backup_${new Date().toISOString().slice(0, 10)}.json`;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Delete only legacy storage keys, preserving Zustand stores.
   * Use this to free up space after migration or to discard old data.
   *
   * @returns DeleteLegacyResult with list of deleted keys and bytes freed
   */
  static deleteLegacyData(): DeleteLegacyResult {
    if (typeof window === 'undefined') {
      return { deleted: [], freedBytes: 0 };
    }

    const deleted: string[] = [];
    let freedBytes = 0;

    for (const key of LEGACY_STORAGE_KEYS) {
      const size = getItemSize(key);
      if (size > 0) {
        freedBytes += size;
        localStorage.removeItem(key);
        deleted.push(key);
      }
    }

    // Also remove migration-related keys
    const migrationKeys = [
      'data_migration_v2_complete',
      'data_migration_backup',
    ];
    for (const key of migrationKeys) {
      const size = getItemSize(key);
      if (size > 0) {
        freedBytes += size;
        localStorage.removeItem(key);
        deleted.push(key);
      }
    }

    console.log(
      `🗑️ Deleted ${deleted.length} legacy keys, freed ${freedBytes} bytes`,
    );

    return { deleted, freedBytes };
  }

  /**
   * Check if there is any legacy data that could be deleted or migrated.
   * This is different from hasLegacyData() which also checks the migration flag.
   *
   * @returns true if any legacy storage keys have data
   */
  static hasAnyLegacyData(): boolean {
    if (typeof window === 'undefined') return false;

    for (const key of LEGACY_STORAGE_KEYS) {
      if (localStorage.getItem(key)) {
        return true;
      }
    }
    return false;
  }
}
