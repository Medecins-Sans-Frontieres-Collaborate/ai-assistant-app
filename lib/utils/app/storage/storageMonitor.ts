/**
 * Storage Monitor Utility
 *
 * This utility provides functions to:
 * - Track localStorage usage
 * - Calculate size of stored objects
 * - Check if storage is nearing capacity
 * - Provide functions to manage conversations by recency
 * - Calculate potential space savings
 *
 * Updated for Zustand persist middleware
 */
import { Conversation } from '@/types/chat';
import { StorageBreakdown } from '@/types/storage';

import { useConversationStore } from '@/client/stores/conversationStore';

// Constants
export const STORAGE_THRESHOLDS = {
  WARNING: 70, // First warning level at 70% full
  CRITICAL: 85, // Critical level at 85% full
  EMERGENCY: 95, // Emergency level at 95% full
};
export const MIN_RETAINED_CONVERSATIONS = 5; // Minimum number of conversations to keep

// Local storage key for dismissed thresholds
const DISMISSED_THRESHOLDS_KEY = 'dismissedStorageThresholds';

// Zustand persist storage keys (these are the actual localStorage keys)
const ZUSTAND_STORAGE_KEYS = {
  CONVERSATIONS: 'conversation-storage', // Zustand persist key for conversationStore
  SETTINGS: 'settings-storage', // Zustand persist key for settingsStore
  UI: 'ui-storage', // Zustand persist key for uiStore
};

/**
 * Legacy localStorage keys that may contain unmigrated data.
 * Exported for use in migration and deletion functions.
 */
export const LEGACY_STORAGE_KEYS = [
  'conversationHistory', // Old conversation storage key
  'conversations', // Alternative legacy conversation key
  'folders', // Legacy folders
  'prompts', // Legacy prompts
  'customAgents', // Legacy custom agents
  'temperature', // Legacy temperature setting
  'systemPrompt', // Legacy system prompt
  'selectedConversationId', // Legacy selected conversation
  'showChatbar', // Legacy UI setting
  'showPromptbar', // Legacy UI setting
  'defaultModelId', // Legacy model setting
  'models', // Legacy models list
] as const;

// Helper to check if we're in a browser environment
export const isBrowserEnv = () =>
  typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

/**
 * Throws an error if not in a browser environment
 * Use this instead of isBrowserEnv checks when browser features are required
 */
export const requireBrowser = (): void => {
  if (!isBrowserEnv()) {
    throw new Error(
      'Browser environment required. This operation needs localStorage or other browser APIs.',
    );
  }
};

/**
 * Calculate the size of a string in bytes
 */
export const getStringSizeInBytes = (str: string): number => {
  if (!str) return 0;
  try {
    // This function doesn't directly use browser APIs that would fail in Node
    const blob = new Blob([str]);
    return blob.size;
  } catch (error) {
    console.error('Error calculating string size:', error);
    // Fallback to string length which is approximately the byte size for ASCII
    return str.length;
  }
};

/**
 * Get the size of an item in localStorage
 */
export const getItemSize = (key: string): number => {
  requireBrowser();

  try {
    const item = localStorage.getItem(key);
    if (!item) return 0;
    return getStringSizeInBytes(item);
  } catch (error) {
    console.error('Error getting item size:', error);
    return 0;
  }
};

/**
 * Get the total size of localStorage and its limit
 */
export const getStorageUsage = () => {
  // Check if we're in a browser environment
  requireBrowser();

  try {
    let totalSize = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        totalSize += getItemSize(key);
      }
    }

    // Estimate maximum storage (varies by browser, typically 5-10MB)
    // Using 5MB as a conservative estimate
    const maxSize = 5 * 1024 * 1024;
    const percentUsed = (totalSize / maxSize) * 100;

    return {
      currentUsage: totalSize,
      maxUsage: maxSize,
      percentUsed: percentUsed,
      isNearingLimit: percentUsed >= STORAGE_THRESHOLDS.WARNING,
    };
  } catch (error) {
    console.error('Error calculating storage usage:', error);
    return {
      currentUsage: 0,
      maxUsage: 5 * 1024 * 1024,
      percentUsed: 0,
      isNearingLimit: false,
    };
  }
};

/**
 * Get a detailed breakdown of localStorage usage by category.
 * Categorizes storage into: Zustand (conversations, settings, ui), Legacy, and Other.
 *
 * @returns Detailed breakdown of storage usage
 */
export const getStorageBreakdown = (): StorageBreakdown => {
  requireBrowser();

  try {
    // Calculate Zustand storage sizes
    const zustandConvs = getItemSize(ZUSTAND_STORAGE_KEYS.CONVERSATIONS);
    const zustandSettings = getItemSize(ZUSTAND_STORAGE_KEYS.SETTINGS);
    const zustandUI = getItemSize(ZUSTAND_STORAGE_KEYS.UI);
    const zustandTotal = zustandConvs + zustandSettings + zustandUI;

    // Calculate legacy storage sizes
    const legacyItems: Array<{ key: string; size: number }> = [];
    let legacyTotal = 0;
    for (const key of LEGACY_STORAGE_KEYS) {
      const size = getItemSize(key);
      if (size > 0) {
        legacyItems.push({ key, size });
        legacyTotal += size;
      }
    }

    // Get total usage
    const { currentUsage, maxUsage } = getStorageUsage();

    // Calculate "other" (anything not Zustand or legacy)
    const other = Math.max(0, currentUsage - zustandTotal - legacyTotal);

    return {
      total: currentUsage,
      maxUsage,
      percentUsed: maxUsage > 0 ? (currentUsage / maxUsage) * 100 : 0,
      zustand: {
        conversations: zustandConvs,
        settings: zustandSettings,
        ui: zustandUI,
        total: zustandTotal,
      },
      legacy: {
        total: legacyTotal,
        hasLegacyData: legacyTotal > 0,
        keys: legacyItems,
      },
      other,
    };
  } catch (error) {
    console.error('Error calculating storage breakdown:', error);
    const maxUsage = 5 * 1024 * 1024;
    return {
      total: 0,
      maxUsage,
      percentUsed: 0,
      zustand: {
        conversations: 0,
        settings: 0,
        ui: 0,
        total: 0,
      },
      legacy: {
        total: 0,
        hasLegacyData: false,
        keys: [],
      },
      other: 0,
    };
  }
};

/**
 * Get the current storage threshold level
 * @returns The current threshold level or null if below all thresholds
 */
export const getCurrentThresholdLevel = (): string | null => {
  requireBrowser();

  const { percentUsed } = getStorageUsage();

  // Check thresholds from highest to lowest
  if (percentUsed >= STORAGE_THRESHOLDS.EMERGENCY) {
    return 'EMERGENCY';
  }

  if (percentUsed >= STORAGE_THRESHOLDS.CRITICAL) {
    return 'CRITICAL';
  }

  if (percentUsed >= STORAGE_THRESHOLDS.WARNING) {
    return 'WARNING';
  }

  return null;
};

/**
 * Get dismissed thresholds from localStorage
 */
export const getDismissedThresholds = (): string[] => {
  requireBrowser();

  try {
    const dismissed = localStorage.getItem(DISMISSED_THRESHOLDS_KEY);
    return dismissed ? JSON.parse(dismissed) : [];
  } catch (error) {
    console.error('Error getting dismissed thresholds:', error);
    return [];
  }
};

/**
 * Save dismissed threshold to localStorage
 */
export const dismissThreshold = (threshold: string): void => {
  requireBrowser();

  try {
    const dismissed = getDismissedThresholds();
    if (!dismissed.includes(threshold)) {
      dismissed.push(threshold);
      localStorage.setItem(DISMISSED_THRESHOLDS_KEY, JSON.stringify(dismissed));
    }
  } catch (error) {
    console.error('Error dismissing threshold:', error);
  }
};

/**
 * Reset dismissed thresholds (called when user takes action to free space)
 */
export const resetDismissedThresholds = (): void => {
  requireBrowser();

  try {
    localStorage.removeItem(DISMISSED_THRESHOLDS_KEY);
  } catch (error) {
    console.error('Error resetting dismissed thresholds:', error);
  }
};

/**
 * Check if storage is nearing its limit
 * @deprecated Use getCurrentThresholdLevel instead
 */
export const isStorageNearingLimit = (): boolean => {
  requireBrowser();
  const { isNearingLimit } = getStorageUsage();
  return isNearingLimit === true;
};

/**
 * Check if a storage warning should be shown
 * @returns Object with shouldShow flag and current threshold level
 */
export const shouldShowStorageWarning = () => {
  const currentThreshold = getCurrentThresholdLevel();

  // If no threshold is reached, don't show warning
  if (!currentThreshold) {
    return { shouldShow: false, currentThreshold: null };
  }

  // For EMERGENCY level, always show warning regardless of dismissals
  if (currentThreshold === 'EMERGENCY') {
    return { shouldShow: true, currentThreshold };
  }

  // Check if this threshold has been dismissed
  const dismissedThresholds = getDismissedThresholds();
  const isDismissed = dismissedThresholds.includes(currentThreshold);

  return {
    shouldShow: !isDismissed,
    currentThreshold,
  };
};

/**
 * Update storage statistics
 */
export const updateStorageStats = () => {
  const usageData = getStorageUsage();
  const { shouldShow, currentThreshold } = shouldShowStorageWarning();

  return {
    usageData,
    isNearingLimit: usageData.isNearingLimit, // For backward compatibility
    currentThreshold,
    shouldShowWarning: shouldShow,
  };
};

/**
 * Get conversations sorted by date (most recent first)
 * Updated to read from Zustand persist structure
 */
export const getSortedConversations = (): Conversation[] => {
  requireBrowser();

  try {
    // Read from Zustand persist structure: {state: {conversations: [...]}, version: 1}
    const conversationStorageJson = localStorage.getItem(
      ZUSTAND_STORAGE_KEYS.CONVERSATIONS,
    );
    if (!conversationStorageJson) return [];

    const persistedData = JSON.parse(conversationStorageJson);
    const conversations: Conversation[] =
      persistedData?.state?.conversations || [];

    // Separate conversations with and without dates
    const conversationsWithDates: Conversation[] = [];
    const conversationsWithoutDates: Conversation[] = [];

    for (const conversation of conversations) {
      const hasDate = conversation.updatedAt || conversation.createdAt;
      if (hasDate) {
        conversationsWithDates.push(conversation);
      } else {
        conversationsWithoutDates.push(conversation);
      }
    }

    // Sort conversations with dates (most recent first)
    conversationsWithDates.sort((a, b) => {
      const dateA =
        a.messages.length > 0 && a.updatedAt
          ? new Date(a.updatedAt).getTime()
          : a.createdAt
            ? new Date(a.createdAt).getTime()
            : 0;

      const dateB =
        b.messages.length > 0 && b.updatedAt
          ? new Date(b.updatedAt).getTime()
          : b.createdAt
            ? new Date(b.createdAt).getTime()
            : 0;

      return dateB - dateA;
    });

    // Return dated conversations first (sorted), followed by legacy conversations (in original order)
    return [...conversationsWithDates, ...conversationsWithoutDates];
  } catch (error) {
    console.error('Error getting sorted conversations:', error);
    return [];
  }
};

/**
 * Calculate space that would be freed by removing older conversations
 * Updated for Zustand persist structure
 */
export const calculateSpaceFreed = (
  keepCount: number,
): {
  spaceFreed: number;
  conversationsRemoved: number;
  percentFreed: number;
} => {
  requireBrowser();

  try {
    const sortedConversations = getSortedConversations();
    if (sortedConversations.length <= keepCount) {
      return { spaceFreed: 0, conversationsRemoved: 0, percentFreed: 0 };
    }

    // Get the current size of Zustand conversation storage
    const currentSize = getItemSize(ZUSTAND_STORAGE_KEYS.CONVERSATIONS);

    // Calculate what would be kept (need to account for Zustand persist wrapper)
    const keptConversations = sortedConversations.slice(0, keepCount);
    const keptPersistStructure = {
      state: { conversations: keptConversations },
      version: 1,
    };
    const keptSize = getStringSizeInBytes(JSON.stringify(keptPersistStructure));

    // Calculate space freed
    const spaceFreed = currentSize - keptSize;
    const conversationsRemoved = sortedConversations.length - keepCount;

    // Calculate percentage of total storage freed
    const { currentUsage } = getStorageUsage();
    const percentFreed =
      currentUsage > 0 ? (spaceFreed / currentUsage) * 100 : 0;

    return { spaceFreed, conversationsRemoved, percentFreed };
  } catch (error) {
    console.error('Error calculating space freed:', error);
    return { spaceFreed: 0, conversationsRemoved: 0, percentFreed: 0 };
  }
};

/**
 * Clear older conversations while keeping the most recent ones
 * Updated to use Zustand stores instead of direct localStorage manipulation
 */
export const clearOlderConversations = (keepCount: number): boolean => {
  requireBrowser();

  try {
    if (keepCount < 1) keepCount = MIN_RETAINED_CONVERSATIONS;

    const sortedConversations = getSortedConversations();
    if (sortedConversations.length <= keepCount) {
      return false; // Nothing to clear
    }

    // Get original length to verify if something was cleared
    const originalLength = sortedConversations.length;

    // Keep only the most recent conversations
    const keptConversations = sortedConversations.slice(0, keepCount);

    // Use Zustand store to update conversations
    const conversationStore = useConversationStore.getState();
    const { selectedConversationId, selectConversation, setConversations } =
      conversationStore;

    // Update conversations in the store (this will auto-persist via Zustand persist)
    setConversations(keptConversations);

    // Reset dismissed thresholds since user has taken action
    resetDismissedThresholds();

    // If the selected conversation was removed, update it to the most recent one
    if (selectedConversationId) {
      const isSelectedKept = keptConversations.some(
        (c) => c.id === selectedConversationId,
      );

      if (!isSelectedKept && keptConversations.length > 0) {
        // Always use the first (most recent) conversation as the new selected one
        selectConversation(keptConversations[0].id);
      }
    }

    // Verify that conversations were actually removed
    return originalLength > keptConversations.length;
  } catch (error) {
    console.error('Error clearing older conversations:', error);
    return false;
  }
};
