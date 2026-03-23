/**
 * Type definitions for localStorage operations and migration
 */

/**
 * Enum of all localStorage keys used by the application.
 * These are the legacy keys that may need migration to Zustand stores.
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

/**
 * Statistics about what was migrated during data migration.
 * Counts represent the number of items actually added (not replaced or skipped).
 */
export interface MigrationStats {
  conversations: number;
  folders: number;
  prompts: number;
  customAgents: number;
}

/**
 * Result of a migration operation.
 * Contains success status, any errors/warnings, and migration statistics.
 */
export interface MigrationResult {
  success: boolean;
  errors: string[];
  warnings: string[];
  skipped: boolean;
  stats: MigrationStats;
}

/**
 * Legacy conversation structure from older localStorage format.
 * Used for validation and migration purposes.
 */
export interface LegacyConversation {
  id: string;
  name: string;
  messages: unknown[];
  [key: string]: unknown;
}

/**
 * Legacy prompt structure from older localStorage format.
 * Used for validation and migration purposes.
 */
export interface LegacyPrompt {
  id: string;
  name: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Legacy custom agent structure from older localStorage format.
 * Used for validation and migration purposes.
 */
export interface LegacyCustomAgent {
  id: string;
  name: string;
  agentId: string;
  [key: string]: unknown;
}

// ============================================================================
// Quota and Incremental Migration Types
// ============================================================================

/**
 * Analysis of storage quota before migration.
 * Used to determine if incremental migration is needed.
 */
export interface QuotaAnalysis {
  /** Current total localStorage usage in bytes */
  currentUsage: number;
  /** Maximum localStorage capacity (typically 5MB) */
  maxUsage: number;
  /** Total size of legacy data to be migrated in bytes */
  legacySize: number;
  /** Estimated size after merging legacy + existing data */
  estimatedMergedSize: number;
  /** Available space in bytes (maxUsage - currentUsage) */
  availableSpace: number;
  /** Whether migration would exceed quota */
  wouldExceedQuota: boolean;
  /** Bytes that need to be freed for migration to succeed (0 if fits) */
  deficit: number;
}

/**
 * Progress tracking for incremental migration.
 * Used to update the UI during migration.
 */
export interface IncrementalProgress {
  /** Current migration phase */
  phase: 'conversations' | 'prompts' | 'agents' | 'complete';
  /** Current item index (1-based) */
  current: number;
  /** Total items in current phase */
  total: number;
  /** Total bytes freed so far */
  bytesFreed: number;
}

/**
 * Information about an item that was skipped during migration.
 */
export interface SkippedItem {
  /** Unique identifier of the skipped item */
  id: string;
  /** Display name of the item */
  name: string;
  /** Type of item that was skipped */
  type: 'conversation' | 'prompt' | 'agent';
  /** Size of the item in bytes */
  size: number;
  /** Reason the item was skipped */
  reason: 'too_large' | 'quota_exceeded';
}

/**
 * Extended migration result for incremental migration mode.
 * Includes information about skipped items.
 */
export interface IncrementalMigrationResult extends MigrationResult {
  /** Items that could not be migrated due to quota constraints */
  skippedItems: SkippedItem[];
  /** Whether any items were skipped */
  hasSkippedItems: boolean;
}

// ============================================================================
// Storage Breakdown Types
// ============================================================================

/**
 * Detailed breakdown of localStorage usage by category.
 * Used to show users where their storage is being used.
 */
export interface StorageBreakdown {
  /** Total localStorage usage in bytes */
  total: number;
  /** Maximum localStorage capacity (typically 5MB) */
  maxUsage: number;
  /** Percentage of total capacity used */
  percentUsed: number;

  /** Zustand-managed storage breakdown */
  zustand: {
    /** Size of conversation-storage key in bytes */
    conversations: number;
    /** Size of settings-storage key in bytes */
    settings: number;
    /** Size of ui-storage key in bytes */
    ui: number;
    /** Total Zustand storage size in bytes */
    total: number;
  };

  /** Legacy storage awaiting migration */
  legacy: {
    /** Total size of all legacy keys in bytes */
    total: number;
    /** Whether any legacy data exists */
    hasLegacyData: boolean;
    /** Individual legacy keys and their sizes */
    keys: Array<{ key: string; size: number }>;
  };

  /** Other localStorage keys not managed by the app (in bytes) */
  other: number;
}

/**
 * Result of deleting legacy data.
 */
export interface DeleteLegacyResult {
  /** List of keys that were deleted */
  deleted: string[];
  /** Total bytes freed by deletion */
  freedBytes: number;
}

// ============================================================================
// Quarantine and Recovery Types
// ============================================================================

/**
 * A conversation that failed validation and was quarantined for potential recovery.
 * The raw data is preserved as-is to maximize recovery chances.
 */
export interface QuarantinedItem {
  /** Original conversation id if recoverable, or generated UUID */
  id: string;
  /** Raw JSON string preserved exactly as found in localStorage */
  rawData: string;
  /** Validation errors that caused quarantine */
  errors: string[];
  /** ISO timestamp when the item was quarantined */
  quarantinedAt: string;
  /** The localStorage key the data came from */
  sourceKey: string;
  /** Whether a recovery attempt has been made */
  recoveryAttempted: boolean;
}

/**
 * Statistics about a recovery attempt.
 */
export interface RecoveryStats {
  /** Number of messages successfully recovered */
  messagesRecovered: number;
  /** Number of messages that could not be recovered */
  messagesLost: number;
  /** Fields that were repaired with default values */
  fieldsRepaired: string[];
}

/**
 * Result of attempting to recover a quarantined conversation.
 */
export interface RecoveryResult {
  /** Whether recovery produced a usable conversation */
  recovered: boolean;
  /** The recovered conversation (if successful) */
  conversation?: import('@/types/chat').Conversation;
  /** Statistics about what was recovered/lost */
  stats: RecoveryStats;
}

/**
 * Index stored in localStorage that tracks per-conversation keys.
 * Used by the per-conversation storage adapter (v5+).
 */
export interface ConversationIndex {
  /** Storage format version */
  version: number;
  /** IDs of conversations stored in individual keys */
  conversationIds: string[];
  /** Currently selected conversation ID */
  selectedConversationId: string | null;
  /** IDs of folders stored in individual keys */
  folderIds: string[];
}
