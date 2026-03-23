/**
 * Per-Conversation Storage Adapter
 *
 * Custom Zustand StateStorage implementation that stores each conversation
 * in its own localStorage key, isolating corruption to individual conversations.
 *
 * Key scheme:
 *   conv-index       → ConversationIndex (metadata + list of IDs)
 *   conv-data-{id}   → Conversation JSON
 *   conv-folder-{id} → FolderInterface JSON
 *   conv-quarantine   → QuarantinedItem[] (managed by quarantineStore)
 *
 * Migration: On first read, if conv-index doesn't exist but the legacy
 * conversation-storage blob does, it performs an automatic migration.
 */
import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';
import { ConversationIndex } from '@/types/storage';

import {
  tryParseJSON,
  validateConversation,
  validateFolder,
} from './conversationValidator';
import { quarantineConversation } from './quarantineStore';
import { attemptRecovery } from './recoveryService';

import type { StateStorage } from 'zustand/middleware';

const INDEX_KEY = 'conv-index';
const CONV_PREFIX = 'conv-data-';
const FOLDER_PREFIX = 'conv-folder-';
const LEGACY_BLOB_KEY = 'conversation-storage';

// Cache of last-written updatedAt per conversation, used for diffing in setItem
const lastWrittenTimestamps = new Map<string, string | undefined>();

/**
 * Read the conversation index from localStorage.
 */
function readIndex(): ConversationIndex | null {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return null;
  const result = tryParseJSON<ConversationIndex>(raw);
  return result.data ?? null;
}

/**
 * Write the conversation index to localStorage.
 */
function writeIndex(index: ConversationIndex): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

/**
 * Load a single conversation from its per-conversation key.
 * On parse/validation failure, attempts auto-recovery before quarantining.
 * Only deletes source data if quarantine write succeeds.
 */
function loadConversation(id: string): Conversation | null {
  const key = `${CONV_PREFIX}${id}`;
  const raw = localStorage.getItem(key);

  if (!raw) {
    console.warn(`[PerConvStorage] Missing data for conversation ${id}`);
    return null;
  }

  const parsed = tryParseJSON<unknown>(raw);
  if (!parsed.data) {
    console.warn(
      `[PerConvStorage] JSON parse failed for ${key}: ${parsed.error}`,
    );
    // Attempt auto-recovery before quarantining
    const recovery = attemptRecovery(raw);
    if (recovery.recovered && recovery.conversation) {
      console.log(
        `[PerConvStorage] Auto-recovered conversation ${id} (${recovery.stats.fieldsRepaired.join(', ')})`,
      );
      // Write recovered version back
      try {
        localStorage.setItem(key, JSON.stringify(recovery.conversation));
      } catch {
        // Write-back failed, but we can still return the recovered data for in-memory use
      }
      return recovery.conversation;
    }
    // Recovery failed — quarantine, only delete source if quarantine succeeded
    const quarantined = quarantineConversation(
      raw,
      [`JSON parse error: ${parsed.error}`],
      key,
    );
    if (quarantined) {
      localStorage.removeItem(key);
    }
    return null;
  }

  const validation = validateConversation(parsed.data);
  if (!validation.valid) {
    console.warn(
      `[PerConvStorage] Validation failed for ${key}:`,
      validation.errors,
    );
    // Attempt auto-recovery before quarantining
    const recovery = attemptRecovery(raw);
    if (recovery.recovered && recovery.conversation) {
      console.log(
        `[PerConvStorage] Auto-recovered conversation ${id} (${recovery.stats.fieldsRepaired.join(', ')})`,
      );
      try {
        localStorage.setItem(key, JSON.stringify(recovery.conversation));
      } catch {
        // Write-back failed, but we can still return the recovered data
      }
      return recovery.conversation;
    }
    // Recovery failed — quarantine, only delete source if quarantine succeeded
    const quarantined = quarantineConversation(raw, validation.errors, key);
    if (quarantined) {
      localStorage.removeItem(key);
    }
    return null;
  }

  return validation.data!;
}

/**
 * Load a single folder from its per-folder key.
 */
function loadFolder(id: string): FolderInterface | null {
  const key = `${FOLDER_PREFIX}${id}`;
  const raw = localStorage.getItem(key);

  if (!raw) return null;

  const parsed = tryParseJSON<unknown>(raw);
  if (!parsed.data) return null;

  const validation = validateFolder(parsed.data);
  if (!validation.valid) return null;

  return validation.data!;
}

/**
 * Migrate from legacy single-blob format (conversation-storage) to per-conversation keys.
 * Validates each conversation individually, quarantining corrupt ones.
 */
function migrateFromLegacyBlob(): {
  conversations: Conversation[];
  selectedConversationId: string | null;
  folders: FolderInterface[];
  version: number;
} | null {
  const raw = localStorage.getItem(LEGACY_BLOB_KEY);
  if (!raw) return null;

  const parsed = tryParseJSON<{
    state?: {
      conversations?: unknown[];
      selectedConversationId?: string | null;
      folders?: unknown[];
    };
    version?: number;
  }>(raw);

  if (!parsed.data?.state) {
    // Entire blob is unparseable — quarantine the whole thing
    const quarantined = quarantineConversation(
      raw,
      ['Entire conversation blob unparseable'],
      LEGACY_BLOB_KEY,
    );
    // Only delete legacy blob if quarantine succeeded (data is preserved)
    if (quarantined) {
      localStorage.removeItem(LEGACY_BLOB_KEY);
    }
    return {
      conversations: [],
      selectedConversationId: null,
      folders: [],
      version: parsed.data?.version ?? 1,
    };
  }

  const { state, version = 1 } = parsed.data;
  const conversations: Conversation[] = [];
  const folders: FolderInterface[] = [];
  // Track IDs that were successfully written to localStorage,
  // so the index only references data that actually persisted.
  const writtenConvIds: string[] = [];
  const writtenFolderIds: string[] = [];

  // Validate and write each conversation individually
  if (Array.isArray(state.conversations)) {
    for (const conv of state.conversations) {
      const validation = validateConversation(conv);
      if (validation.valid && validation.data) {
        conversations.push(validation.data); // always include for in-memory state
        try {
          localStorage.setItem(
            `${CONV_PREFIX}${validation.data.id}`,
            JSON.stringify(validation.data),
          );
          writtenConvIds.push(validation.data.id);
          lastWrittenTimestamps.set(
            validation.data.id,
            validation.data.updatedAt,
          );
        } catch (e) {
          console.error(
            `[PerConvStorage] Failed to write conv-data-${validation.data.id}:`,
            e,
          );
          // Don't add to writtenConvIds — index won't reference this conversation
        }
      } else {
        // Attempt auto-recovery before quarantining
        const convRaw = JSON.stringify(conv);
        const recovery = attemptRecovery(convRaw);
        if (recovery.recovered && recovery.conversation) {
          console.log(
            `[PerConvStorage] Auto-recovered conversation during migration (${recovery.stats.fieldsRepaired.join(', ')})`,
          );
          conversations.push(recovery.conversation);
          try {
            localStorage.setItem(
              `${CONV_PREFIX}${recovery.conversation.id}`,
              JSON.stringify(recovery.conversation),
            );
            writtenConvIds.push(recovery.conversation.id);
            lastWrittenTimestamps.set(
              recovery.conversation.id,
              recovery.conversation.updatedAt,
            );
          } catch (e) {
            console.error(
              `[PerConvStorage] Failed to write recovered conv-data-${recovery.conversation.id}:`,
              e,
            );
          }
        } else {
          quarantineConversation(convRaw, validation.errors, LEGACY_BLOB_KEY);
        }
      }
    }
  }

  // Validate and write each folder individually
  if (Array.isArray(state.folders)) {
    for (const folder of state.folders) {
      const validation = validateFolder(folder);
      if (validation.valid && validation.data) {
        folders.push(validation.data); // always include for in-memory state
        try {
          localStorage.setItem(
            `${FOLDER_PREFIX}${validation.data.id}`,
            JSON.stringify(validation.data),
          );
          writtenFolderIds.push(validation.data.id);
        } catch (e) {
          console.error(
            `[PerConvStorage] Failed to write conv-folder-${validation.data.id}:`,
            e,
          );
        }
      }
    }
  }

  // Write the index — only reference IDs that were successfully persisted
  const index: ConversationIndex = {
    version: 5,
    conversationIds: writtenConvIds,
    selectedConversationId:
      (state.selectedConversationId as string | null) ?? null,
    folderIds: writtenFolderIds,
  };

  try {
    writeIndex(index);
    // Only remove legacy blob after the index is successfully written
    localStorage.removeItem(LEGACY_BLOB_KEY);
  } catch (e) {
    console.error(
      '[PerConvStorage] Failed to write index during migration, preserving legacy blob:',
      e,
    );
    // Legacy blob is preserved — next load will retry migration
  }

  console.log(
    `[PerConvStorage] Migrated from legacy blob: ${conversations.length} conversations, ${folders.length} folders`,
  );

  return {
    conversations,
    selectedConversationId: index.selectedConversationId,
    folders,
    version,
  };
}

/**
 * Custom Zustand StateStorage that stores conversations in individual localStorage keys.
 */
export const perConversationStorage: StateStorage = {
  getItem(name: string): string | null {
    try {
      // Check for per-conversation index first
      const index = readIndex();

      if (index) {
        // Load conversations individually
        const conversations: Conversation[] = [];
        const validIds: string[] = [];

        for (const id of index.conversationIds) {
          const conv = loadConversation(id);
          if (conv) {
            conversations.push(conv);
            validIds.push(id);
            lastWrittenTimestamps.set(id, conv.updatedAt);
          }
        }

        // Load folders
        const folders: FolderInterface[] = [];
        const validFolderIds: string[] = [];
        for (const id of index.folderIds) {
          const folder = loadFolder(id);
          if (folder) {
            folders.push(folder);
            validFolderIds.push(id);
          }
        }

        // Update index if some items were quarantined
        if (
          validIds.length !== index.conversationIds.length ||
          validFolderIds.length !== index.folderIds.length
        ) {
          const quarantinedCount =
            index.conversationIds.length - validIds.length;
          if (quarantinedCount > 0) {
            console.warn(
              `[PerConvStorage] ${quarantinedCount} conversation(s) quarantined during load`,
            );
          }
          writeIndex({
            ...index,
            conversationIds: validIds,
            folderIds: validFolderIds,
          });
        }

        // Return in Zustand persist format
        return JSON.stringify({
          state: {
            conversations,
            selectedConversationId: index.selectedConversationId,
            folders,
          },
          version: index.version,
        });
      }

      // No index found — check for legacy blob and migrate
      const migrated = migrateFromLegacyBlob();
      if (migrated) {
        return JSON.stringify({
          state: {
            conversations: migrated.conversations,
            selectedConversationId: migrated.selectedConversationId,
            folders: migrated.folders,
          },
          version: migrated.version,
        });
      }

      // No data at all
      return null;
    } catch (e) {
      console.error('[PerConvStorage] Error in getItem:', e);
      return null;
    }
  },

  setItem(_name: string, value: string): void {
    try {
      const parsed = tryParseJSON<{
        state: {
          conversations: Conversation[];
          selectedConversationId: string | null;
          folders: FolderInterface[];
        };
        version: number;
      }>(value);

      if (!parsed.data) {
        console.error('[PerConvStorage] Failed to parse state for setItem');
        return;
      }

      const { state, version } = parsed.data;
      const currentIndex = readIndex();

      const currentConvIds = new Set(currentIndex?.conversationIds ?? []);
      const currentFolderIds = new Set(currentIndex?.folderIds ?? []);

      const newConvIds = new Set(state.conversations.map((c) => c.id));
      const newFolderIds = new Set(state.folders.map((f) => f.id));

      // Write changed/new conversations
      for (const conv of state.conversations) {
        const lastTimestamp = lastWrittenTimestamps.get(conv.id);
        const isNew = !currentConvIds.has(conv.id);
        const isUpdated = !isNew && conv.updatedAt !== lastTimestamp;

        if (isNew || isUpdated) {
          try {
            localStorage.setItem(
              `${CONV_PREFIX}${conv.id}`,
              JSON.stringify(conv),
            );
            lastWrittenTimestamps.set(conv.id, conv.updatedAt);
          } catch (e) {
            if (e instanceof Error && e.name === 'QuotaExceededError') {
              console.error(
                `[PerConvStorage] QuotaExceededError writing ${conv.id}`,
              );
              if (isNew) {
                // New conversation with no prior stored copy — remove from index
                newConvIds.delete(conv.id);
              }
              // For existing conversations: keep the id in newConvIds so the
              // old stored version is preserved (don't update the timestamp cache)
            } else {
              throw e;
            }
          }
        }
      }

      // Write all folders (folders are small — always write to catch renames)
      for (const folder of state.folders) {
        try {
          localStorage.setItem(
            `${FOLDER_PREFIX}${folder.id}`,
            JSON.stringify(folder),
          );
        } catch (e) {
          if (e instanceof Error && e.name === 'QuotaExceededError') {
            console.error(
              `[PerConvStorage] QuotaExceededError writing folder ${folder.id}`,
            );
            if (!currentFolderIds.has(folder.id)) {
              newFolderIds.delete(folder.id);
            }
          } else {
            throw e;
          }
        }
      }

      // Remove deleted conversations
      for (const id of currentConvIds) {
        if (!newConvIds.has(id)) {
          localStorage.removeItem(`${CONV_PREFIX}${id}`);
          lastWrittenTimestamps.delete(id);
        }
      }

      // Remove deleted folders
      for (const id of currentFolderIds) {
        if (!newFolderIds.has(id)) {
          localStorage.removeItem(`${FOLDER_PREFIX}${id}`);
        }
      }

      // Write index last (so partial failures don't leave inconsistent state)
      const index: ConversationIndex = {
        version: version ?? 5,
        conversationIds: Array.from(newConvIds),
        selectedConversationId: state.selectedConversationId,
        folderIds: Array.from(newFolderIds),
      };
      writeIndex(index);
    } catch (e) {
      console.error('[PerConvStorage] Error in setItem:', e);
    }
  },

  removeItem(_name: string): void {
    try {
      const index = readIndex();
      if (index) {
        for (const id of index.conversationIds) {
          localStorage.removeItem(`${CONV_PREFIX}${id}`);
        }
        for (const id of index.folderIds) {
          localStorage.removeItem(`${FOLDER_PREFIX}${id}`);
        }
      }
      localStorage.removeItem(INDEX_KEY);
      lastWrittenTimestamps.clear();
    } catch (e) {
      console.error('[PerConvStorage] Error in removeItem:', e);
    }
  },
};

/**
 * Get all localStorage keys used by the per-conversation storage.
 * Useful for storage monitoring and cleanup.
 */
export function getPerConversationStorageKeys(): string[] {
  const keys: string[] = [INDEX_KEY];
  const index = readIndex();
  if (index) {
    for (const id of index.conversationIds) {
      keys.push(`${CONV_PREFIX}${id}`);
    }
    for (const id of index.folderIds) {
      keys.push(`${FOLDER_PREFIX}${id}`);
    }
  }
  return keys;
}

/**
 * Get the total size in bytes of all per-conversation storage keys.
 */
export function getPerConversationStorageSize(): number {
  try {
    let total = 0;
    for (const key of getPerConversationStorageKeys()) {
      const item = localStorage.getItem(key);
      if (item) {
        total += item.length * 2; // UTF-16 encoding: 2 bytes per char
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Clear all per-conversation storage keys and the quarantine.
 * Used as an emergency reset escape hatch.
 */
export function clearAllConversationStorage(): void {
  const index = readIndex();
  if (index) {
    for (const id of index.conversationIds) {
      localStorage.removeItem(`${CONV_PREFIX}${id}`);
    }
    for (const id of index.folderIds) {
      localStorage.removeItem(`${FOLDER_PREFIX}${id}`);
    }
  }
  localStorage.removeItem(INDEX_KEY);
  localStorage.removeItem('conv-quarantine');
  // Also clear legacy blob if it somehow still exists
  localStorage.removeItem(LEGACY_BLOB_KEY);
  lastWrittenTimestamps.clear();
}

/**
 * Export all raw conversation storage data for diagnostic purposes.
 * Collects data from both v5 per-conversation keys and v4 legacy blob,
 * plus any quarantined items. Does not attempt to parse — preserves raw strings
 * so even corrupted data is captured.
 *
 * Returns a JSON string that can be saved to a file.
 */
export function exportRawConversationData(): string {
  const data: Record<string, string | null> = {};

  try {
    // v5 per-conversation keys
    const indexRaw = localStorage.getItem(INDEX_KEY);
    data[INDEX_KEY] = indexRaw;

    if (indexRaw) {
      try {
        const index = JSON.parse(indexRaw) as ConversationIndex;
        for (const id of index.conversationIds) {
          const key = `${CONV_PREFIX}${id}`;
          data[key] = localStorage.getItem(key);
        }
        for (const id of index.folderIds) {
          const key = `${FOLDER_PREFIX}${id}`;
          data[key] = localStorage.getItem(key);
        }
      } catch {
        // Index itself is corrupted — scan localStorage for conv-data-* keys
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (
            key &&
            (key.startsWith(CONV_PREFIX) || key.startsWith(FOLDER_PREFIX))
          ) {
            data[key] = localStorage.getItem(key);
          }
        }
      }
    }

    // v4 legacy blob (may still exist if migration failed)
    const legacyBlob = localStorage.getItem(LEGACY_BLOB_KEY);
    if (legacyBlob) {
      data[LEGACY_BLOB_KEY] = legacyBlob;
    }

    // Quarantined items
    const quarantine = localStorage.getItem('conv-quarantine');
    if (quarantine) {
      data['conv-quarantine'] = quarantine;
    }
  } catch (e) {
    data['_export_error'] = String(e);
  }

  return JSON.stringify(data, null, 2);
}

// Export constants for use in other modules
export { CONV_PREFIX, FOLDER_PREFIX, INDEX_KEY, LEGACY_BLOB_KEY };
