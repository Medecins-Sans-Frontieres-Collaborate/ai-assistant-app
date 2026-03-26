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
 *
 * Quarantine policy: BEST-EFFORT PRESERVE, ALWAYS PROCEED.
 * When corrupted data is encountered, we attempt to quarantine the raw bytes
 * for potential export/inspection. If the quarantine write itself fails (e.g.,
 * storage full), we still proceed — delete the source key and continue loading.
 * The app staying functional takes priority over preserving every corrupted byte.
 * Conversation data may be sensitive, so quarantine storage should be minimal.
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
import { attemptRecovery, repairJSON } from './recoveryService';

import type { StateStorage } from 'zustand/middleware';

const INDEX_KEY = 'conv-index';
const CONV_PREFIX = 'conv-data-';
const FOLDER_PREFIX = 'conv-folder-';
const LEGACY_BLOB_KEY = 'conversation-storage';

/**
 * Check if an error is a QuotaExceededError.
 * Browsers throw DOMException (not Error), so instanceof Error misses it.
 */
function isQuotaError(e: unknown): boolean {
  return (e as { name?: string })?.name === 'QuotaExceededError';
}

// Cache of last-written updatedAt per conversation, used for diffing in setItem
const lastWrittenTimestamps = new Map<string, string | undefined>();

// IDs loaded from a deferred/rolled-back legacy migration (in-memory only, not persisted).
// setItem must exclude these to avoid silently retrying migration outside the guarded path.
const blobOnlyIds = new Set<string>();
const blobOnlyFolderIds = new Set<string>();

/**
 * Validate that a parsed object is a well-formed ConversationIndex.
 */
function isValidIndex(data: unknown): data is ConversationIndex {
  if (!data || typeof data !== 'object') return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.conversationIds) && Array.isArray(obj.folderIds);
}

/**
 * Read the conversation index from localStorage.
 * Returns null if missing or malformed (callers should try rebuildIndexFromKeys).
 */
function readIndex(): ConversationIndex | null {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return null;
  const result = tryParseJSON<ConversationIndex>(raw);
  if (!result.data || !isValidIndex(result.data)) {
    console.warn(
      '[PerConvStorage] conv-index exists but is malformed, will attempt rebuild',
    );
    return null;
  }
  return result.data;
}

/**
 * Rebuild the conversation index by scanning localStorage for conv-data-* and conv-folder-* keys.
 * Used as a fallback when conv-index is missing or corrupted but per-conversation keys exist.
 */
function rebuildIndexFromKeys(): ConversationIndex | null {
  const conversationIds: string[] = [];
  const folderIds: string[] = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(CONV_PREFIX)) {
      conversationIds.push(key.slice(CONV_PREFIX.length));
    } else if (key.startsWith(FOLDER_PREFIX)) {
      folderIds.push(key.slice(FOLDER_PREFIX.length));
    }
  }

  if (conversationIds.length === 0 && folderIds.length === 0) {
    return null;
  }

  console.log(
    `[PerConvStorage] Rebuilt index from keys: ${conversationIds.length} conversations, ${folderIds.length} folders`,
  );

  const index: ConversationIndex = {
    version: 5,
    conversationIds,
    selectedConversationId: null,
    folderIds,
  };

  // Persist the rebuilt index
  try {
    writeIndex(index);
  } catch (e) {
    console.error('[PerConvStorage] Failed to persist rebuilt index:', e);
  }

  return index;
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
 * Follows best-effort quarantine policy: always proceeds even if quarantine fails.
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
    // Recovery failed — best-effort quarantine, then proceed
    quarantineConversation(
      raw,
      [`JSON parse error: ${parsed.error}`],
      key,
      'conversation',
    );
    localStorage.removeItem(key);
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
    // Recovery failed — best-effort quarantine, then proceed
    quarantineConversation(raw, validation.errors, key, 'conversation');
    localStorage.removeItem(key);
    return null;
  }

  // If messages were stripped during validation, quarantine the raw data as backup
  if (validation.messagesStripped && validation.messagesStripped > 0) {
    console.warn(
      `[PerConvStorage] ${validation.messagesStripped} invalid message(s) stripped from ${key}, quarantining raw backup`,
    );
    quarantineConversation(
      raw,
      [
        `${validation.messagesStripped} invalid message entries stripped during validation`,
      ],
      key,
      'backup',
    );
    // Write sanitized version back (best-effort)
    try {
      localStorage.setItem(key, JSON.stringify(validation.data));
    } catch {
      // Write-back failed, but we still return the sanitized data for in-memory use
    }
  }

  return validation.data!;
}

/**
 * Load a single folder from its per-folder key.
 * Quarantines corrupted folder data before returning null.
 */
function loadFolder(id: string): FolderInterface | null {
  const key = `${FOLDER_PREFIX}${id}`;
  const raw = localStorage.getItem(key);

  if (!raw) return null;

  const parsed = tryParseJSON<unknown>(raw);
  if (!parsed.data) {
    quarantineConversation(
      raw,
      [`Folder JSON parse error: ${parsed.error}`],
      key,
      'folder',
    );
    localStorage.removeItem(key);
    return null;
  }

  const validation = validateFolder(parsed.data);
  if (!validation.valid) {
    quarantineConversation(raw, validation.errors, key, 'folder');
    localStorage.removeItem(key);
    return null;
  }

  return validation.data!;
}

/**
 * Best-effort extraction of conversation objects from a corrupted blob string.
 * Uses regex to find JSON objects that look like conversations (have id, name, messages fields),
 * then validates each one individually. Returns whatever is salvageable.
 */
/**
 * Extract a balanced JSON object from a raw string starting at `startIdx`,
 * respecting quoted strings (so braces inside message content don't break it).
 * Returns the end index (exclusive) or -1 if unbalanced.
 */
function findBalancedObjectEnd(raw: string, startIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') depth--;

    if (depth === 0) return i + 1;
  }

  return -1; // Unbalanced
}

function salvageConversationsFromBlob(raw: string): Conversation[] {
  const salvaged: Conversation[] = [];
  const seenIds = new Set<string>();

  // Relaxed pattern: find objects that start with {"id": (any property order after)
  const conversationPattern = /\{"id"\s*:\s*"[^"]+"/g;
  let match;

  while ((match = conversationPattern.exec(raw)) !== null) {
    const startIdx = match.index;
    const endIdx = findBalancedObjectEnd(raw, startIdx);
    if (endIdx === -1) continue;

    const fragment = raw.slice(startIdx, endIdx);
    const parsed = tryParseJSON<unknown>(fragment);
    if (!parsed.data) continue;

    const validation = validateConversation(parsed.data);
    if (validation.valid && validation.data) {
      if (!seenIds.has(validation.data.id)) {
        salvaged.push(validation.data);
        seenIds.add(validation.data.id);
      }
    } else {
      const recovery = attemptRecovery(fragment);
      if (recovery.recovered && recovery.conversation) {
        if (!seenIds.has(recovery.conversation.id)) {
          salvaged.push(recovery.conversation);
          seenIds.add(recovery.conversation.id);
        }
      }
    }
  }

  return salvaged;
}

/**
 * Parse blob data directly without writing per-conversation keys.
 * Used when automatic migration is skipped (quota pressure) or rolled back.
 * Validates and sanitizes conversations for in-memory use; blob stays intact for MigrationDialog.
 */
function parseBlobDataDirectly(
  state: {
    conversations?: unknown[];
    selectedConversationId?: string | null;
    folders?: unknown[];
  },
  version: number,
): {
  conversations: Conversation[];
  selectedConversationId: string | null;
  folders: FolderInterface[];
  version: number;
  persisted: boolean;
} {
  const conversations: Conversation[] = [];
  const folders: FolderInterface[] = [];

  if (Array.isArray(state.conversations)) {
    for (const conv of state.conversations) {
      const validation = validateConversation(conv);
      if (validation.valid && validation.data) {
        conversations.push(validation.data);
      } else {
        const recovery = attemptRecovery(JSON.stringify(conv));
        if (recovery.recovered && recovery.conversation) {
          conversations.push(recovery.conversation);
        }
      }
    }
  }

  if (Array.isArray(state.folders)) {
    for (const folder of state.folders) {
      const validation = validateFolder(folder);
      if (validation.valid && validation.data) {
        folders.push(validation.data);
      }
    }
  }

  return {
    conversations,
    selectedConversationId:
      typeof state.selectedConversationId === 'string'
        ? state.selectedConversationId
        : null,
    folders,
    version,
    persisted: false,
  };
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
  /** Whether per-conv keys were actually written. False = blob-only fallback for in-memory use. */
  persisted: boolean;
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
    // Attempt JSON repair before giving up (handles truncation, trailing commas)
    const repaired = repairJSON(raw);
    const repairedParsed = tryParseJSON<{
      state?: {
        conversations?: unknown[];
        selectedConversationId?: string | null;
        folders?: unknown[];
      };
      version?: number;
    }>(repaired);

    if (repairedParsed.data?.state) {
      // Repair succeeded — re-run migration with the repaired data
      console.log(
        '[PerConvStorage] JSON repair succeeded on legacy blob, retrying migration',
      );
      // Replace the blob with the repaired version and recurse
      try {
        localStorage.setItem(LEGACY_BLOB_KEY, repaired);
        return migrateFromLegacyBlob();
      } catch {
        // Quota or storage error — fall through to salvage/quarantine
        console.warn(
          '[PerConvStorage] Failed to persist repaired legacy blob, falling back to salvage/quarantine',
        );
      }
    }

    // Attempt to salvage individual conversations from the corrupted blob
    const salvaged = salvageConversationsFromBlob(raw);
    if (salvaged.length > 0) {
      console.log(
        `[PerConvStorage] Salvaged ${salvaged.length} conversation(s) from corrupted blob`,
      );
      const writtenConvIds: string[] = [];
      for (const conv of salvaged) {
        const convKey = `${CONV_PREFIX}${conv.id}`;
        if (!localStorage.getItem(convKey)) {
          try {
            localStorage.setItem(convKey, JSON.stringify(conv));
            writtenConvIds.push(conv.id);
          } catch {
            // Quota — skip this one
          }
        } else {
          writtenConvIds.push(conv.id);
        }
      }
      if (writtenConvIds.length > 0) {
        const salvageIndex: ConversationIndex = {
          version: 5,
          conversationIds: writtenConvIds,
          selectedConversationId: null,
          folderIds: [],
        };
        try {
          writeIndex(salvageIndex);
          localStorage.removeItem(LEGACY_BLOB_KEY);
        } catch {
          // Index write failed — blob preserved
        }
        // Quarantine the original blob as backup
        quarantineConversation(
          raw,
          [
            `Blob partially corrupted — ${salvaged.length} conversation(s) salvaged`,
          ],
          LEGACY_BLOB_KEY,
          'backup',
        );
        return {
          conversations: salvaged,
          selectedConversationId: null,
          folders: [],
          version: 1,
          persisted: true, // salvaged convs were written to per-conv keys
        };
      }
    }

    // Nothing salvageable — best-effort quarantine, then proceed
    quarantineConversation(
      raw,
      [
        'Entire conversation blob unparseable (JSON repair and salvage both failed)',
      ],
      LEGACY_BLOB_KEY,
      'backup',
    );
    localStorage.removeItem(LEGACY_BLOB_KEY);
    return {
      conversations: [],
      selectedConversationId: null,
      folders: [],
      version: parsed.data?.version ?? 1,
      persisted: false,
    };
  }

  const { state, version = 1 } = parsed.data;

  // Preflight quota check: migration temporarily duplicates data (blob + per-conv keys).
  // If there isn't enough headroom, skip automatic migration and return blob data directly.
  // The MigrationDialog (quota-aware, incremental) handles tight-storage migrations.
  const blobSizeBytes = raw.length * 2; // UTF-16: 2 bytes per char
  let totalStorageBytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      const val = localStorage.getItem(key);
      // Approximate size: UTF-16 = 2 bytes per char (sufficient for preflight threshold)
      if (val !== null) totalStorageBytes += (key.length + val.length) * 2;
    }
  }
  const maxStorageBytes = 5 * 1024 * 1024;
  const availableBytes = maxStorageBytes - totalStorageBytes;

  if (availableBytes < blobSizeBytes * 0.5) {
    console.warn(
      `[PerConvStorage] Insufficient space for automatic migration ` +
        `(available: ${availableBytes}B, blob: ${blobSizeBytes}B). ` +
        `Deferring to MigrationDialog.`,
    );
    return parseBlobDataDirectly(state, version);
  }

  const conversations: Conversation[] = [];
  const folders: FolderInterface[] = [];
  // Track keys written during migration for rollback on quota failure
  const writtenConvIds: string[] = [];
  const writtenFolderIds: string[] = [];
  const writtenKeys: string[] = [];
  let quotaFailure = false;

  // Validate and write each conversation individually
  if (Array.isArray(state.conversations)) {
    for (const conv of state.conversations) {
      if (quotaFailure) break;
      // Capture raw BEFORE validation (which mutates messages in place)
      const convRawBeforeValidation = JSON.stringify(conv);
      const validation = validateConversation(conv);
      if (validation.valid && validation.data) {
        // Quarantine raw backup if messages were stripped during validation
        if (validation.messagesStripped && validation.messagesStripped > 0) {
          quarantineConversation(
            convRawBeforeValidation,
            [
              `${validation.messagesStripped} invalid message entries stripped during migration`,
            ],
            LEGACY_BLOB_KEY,
            'backup',
          );
        }
        // Skip write if a per-conv key already exists (it may be newer from a previous session)
        const convKey = `${CONV_PREFIX}${validation.data.id}`;
        if (localStorage.getItem(convKey)) {
          writtenConvIds.push(validation.data.id);
          conversations.push(validation.data);
          continue;
        }
        try {
          localStorage.setItem(convKey, JSON.stringify(validation.data));
          conversations.push(validation.data);
          writtenConvIds.push(validation.data.id);
          writtenKeys.push(convKey);
          lastWrittenTimestamps.set(
            validation.data.id,
            validation.data.updatedAt,
          );
        } catch (e) {
          if (isQuotaError(e)) {
            console.warn(
              `[PerConvStorage] QuotaExceededError during migration at conv ${validation.data.id}, rolling back`,
            );
            quotaFailure = true;
          } else {
            console.error(
              `[PerConvStorage] Failed to write conv-data-${validation.data.id}:`,
              e,
            );
          }
        }
      } else {
        // Attempt auto-recovery before quarantining (use pre-validation raw)
        const recovery = attemptRecovery(convRawBeforeValidation);
        if (recovery.recovered && recovery.conversation) {
          console.log(
            `[PerConvStorage] Auto-recovered conversation during migration (${recovery.stats.fieldsRepaired.join(', ')})`,
          );
          const recoveredKey = `${CONV_PREFIX}${recovery.conversation.id}`;
          if (localStorage.getItem(recoveredKey)) {
            conversations.push(recovery.conversation);
            writtenConvIds.push(recovery.conversation.id);
          } else {
            try {
              localStorage.setItem(
                recoveredKey,
                JSON.stringify(recovery.conversation),
              );
              conversations.push(recovery.conversation);
              writtenConvIds.push(recovery.conversation.id);
              writtenKeys.push(recoveredKey);
              lastWrittenTimestamps.set(
                recovery.conversation.id,
                recovery.conversation.updatedAt,
              );
            } catch (e) {
              if (isQuotaError(e)) {
                quotaFailure = true;
              } else {
                console.error(
                  `[PerConvStorage] Failed to write recovered conv-data-${recovery.conversation.id}:`,
                  e,
                );
              }
            }
          }
        } else {
          quarantineConversation(
            convRawBeforeValidation,
            validation.errors,
            LEGACY_BLOB_KEY,
            'conversation',
          );
        }
      }
    }
  }

  // On quota failure: rollback all written keys, preserve blob, return blob data
  if (quotaFailure) {
    console.warn(
      `[PerConvStorage] Rolling back ${writtenKeys.length} keys written during failed migration`,
    );
    for (const key of writtenKeys) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Best-effort cleanup
      }
      // Only clear timestamps for rolled-back keys (preserve existing conv timestamps)
      const id = key.startsWith(CONV_PREFIX)
        ? key.slice(CONV_PREFIX.length)
        : null;
      if (id) lastWrittenTimestamps.delete(id);
    }
    return parseBlobDataDirectly(state, version);
  }

  // Validate and write each folder individually
  if (Array.isArray(state.folders)) {
    for (const folder of state.folders) {
      const validation = validateFolder(folder);
      if (validation.valid && validation.data) {
        const folderKey = `${FOLDER_PREFIX}${validation.data.id}`;
        if (localStorage.getItem(folderKey)) {
          folders.push(validation.data);
          writtenFolderIds.push(validation.data.id);
          continue;
        }
        try {
          localStorage.setItem(folderKey, JSON.stringify(validation.data));
          folders.push(validation.data);
          writtenFolderIds.push(validation.data.id);
          writtenKeys.push(folderKey);
        } catch (e) {
          if (isQuotaError(e)) {
            console.warn(
              `[PerConvStorage] QuotaExceededError during migration at folder ${validation.data.id}, rolling back`,
            );
            quotaFailure = true;
            break;
          }
          console.error(
            `[PerConvStorage] Failed to write conv-folder-${validation.data.id}:`,
            e,
          );
        }
      } else {
        quarantineConversation(
          JSON.stringify(folder),
          validation.errors,
          LEGACY_BLOB_KEY,
          'folder',
        );
      }
    }
  }

  // Check for quota failure from folder writes
  if (quotaFailure) {
    console.warn(
      `[PerConvStorage] Rolling back ${writtenKeys.length} keys written during failed migration (folder phase)`,
    );
    for (const key of writtenKeys) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Best-effort cleanup
      }
      const id = key.startsWith(CONV_PREFIX)
        ? key.slice(CONV_PREFIX.length)
        : null;
      if (id) lastWrittenTimestamps.delete(id);
    }
    return parseBlobDataDirectly(state, version);
  }

  // Write the index — only reference IDs that were successfully persisted
  const index: ConversationIndex = {
    version: 5,
    conversationIds: writtenConvIds,
    selectedConversationId:
      typeof state.selectedConversationId === 'string'
        ? state.selectedConversationId
        : null,
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
    persisted: true,
  };
}

/**
 * Custom Zustand StateStorage that stores conversations in individual localStorage keys.
 */
export const perConversationStorage: StateStorage = {
  getItem(name: string): string | null {
    try {
      // Check for per-conversation index first, with rebuild fallback
      let index = readIndex();
      if (!index) {
        // Index missing or malformed — try rebuilding from orphaned conv-data-* keys
        index = rebuildIndexFromKeys();
      }

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

        // Update index if some items were quarantined (best-effort, don't fail hydration)
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
          try {
            writeIndex({
              ...index,
              conversationIds: validIds,
              folderIds: validFolderIds,
            });
          } catch (e) {
            console.warn(
              '[PerConvStorage] Failed to update index after quarantine, continuing with loaded data:',
              e,
            );
          }
        }

        // Check if legacy blob still exists (failed previous migration) and merge unmigrated data
        if (localStorage.getItem(LEGACY_BLOB_KEY)) {
          const merged = migrateFromLegacyBlob();
          if (merged) {
            // Add conversations/folders to in-memory arrays for the current session
            const existingIds = new Set(validIds);
            for (const conv of merged.conversations) {
              if (!existingIds.has(conv.id)) {
                conversations.push(conv);
                if (merged.persisted) {
                  validIds.push(conv.id);
                } else {
                  blobOnlyIds.add(conv.id);
                }
              }
            }
            const existingFolderIds = new Set(validFolderIds);
            for (const folder of merged.folders) {
              if (!existingFolderIds.has(folder.id)) {
                folders.push(folder);
                if (merged.persisted) {
                  validFolderIds.push(folder.id);
                } else {
                  blobOnlyFolderIds.add(folder.id);
                }
              }
            }
            // Use blob's selectedConversationId as fallback if index has none
            const mergedSelectedId =
              index.selectedConversationId ?? merged.selectedConversationId;

            // Only update the persisted index if migration actually wrote per-conv keys
            if (merged.persisted) {
              try {
                writeIndex({
                  ...index,
                  conversationIds: validIds,
                  folderIds: validFolderIds,
                  selectedConversationId: mergedSelectedId,
                });
              } catch (e) {
                console.warn(
                  '[PerConvStorage] Failed to update index after merge, continuing:',
                  e,
                );
              }
            }
            // Update index for the return value
            index = {
              ...index,
              selectedConversationId: mergedSelectedId,
            };
          }
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

      // Exclude blob-only items (deferred migration) — they should only be
      // persisted through the guarded MigrationDialog path, not normal writes.
      const persistableConvs = state.conversations.filter(
        (c) => !blobOnlyIds.has(c.id),
      );
      const persistableFolders = state.folders.filter(
        (f) => !blobOnlyFolderIds.has(f.id),
      );

      const newConvIds = new Set(persistableConvs.map((c) => c.id));
      const newFolderIds = new Set(persistableFolders.map((f) => f.id));

      // Write changed/new conversations
      for (const conv of persistableConvs) {
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
            if (isQuotaError(e)) {
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
      for (const folder of persistableFolders) {
        try {
          localStorage.setItem(
            `${FOLDER_PREFIX}${folder.id}`,
            JSON.stringify(folder),
          );
        } catch (e) {
          if (isQuotaError(e)) {
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

      // Write index before deleting old keys — if index write fails,
      // old keys remain intact and consistent with the previous index.
      // Validate selectedConversationId references a persisted conversation
      const persistedSelectedId =
        state.selectedConversationId &&
        newConvIds.has(state.selectedConversationId)
          ? state.selectedConversationId
          : null;

      const index: ConversationIndex = {
        version: version ?? 5,
        conversationIds: Array.from(newConvIds),
        selectedConversationId: persistedSelectedId,
        folderIds: Array.from(newFolderIds),
      };
      writeIndex(index);

      // Only delete old keys after the index has been successfully written
      for (const id of currentConvIds) {
        if (!newConvIds.has(id)) {
          localStorage.removeItem(`${CONV_PREFIX}${id}`);
          lastWrittenTimestamps.delete(id);
        }
      }
      for (const id of currentFolderIds) {
        if (!newFolderIds.has(id)) {
          localStorage.removeItem(`${FOLDER_PREFIX}${id}`);
        }
      }
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
 * Scan localStorage for all conv-data-* and conv-folder-* keys.
 * Finds orphaned keys not referenced by the index.
 */
function scanAllConversationKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith(CONV_PREFIX) || key.startsWith(FOLDER_PREFIX))) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Get all localStorage keys used by the per-conversation storage.
 * Includes both indexed and orphaned keys.
 * Useful for storage monitoring and cleanup.
 */
export function getPerConversationStorageKeys(): string[] {
  const keys: string[] = [INDEX_KEY, 'conv-quarantine'];

  // Use scan to catch both indexed and orphaned keys
  const scannedKeys = scanAllConversationKeys();
  keys.push(...scannedKeys);
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
 * Get the total size in bytes of only conv-data-* keys (conversations only).
 * Used for accurate storage cleanup estimates (excludes index + folder overhead).
 */
export function getConversationDataSize(): number {
  try {
    let total = 0;
    for (const key of scanAllConversationKeys()) {
      if (key.startsWith(CONV_PREFIX)) {
        const item = localStorage.getItem(key);
        if (item) {
          total += item.length * 2;
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Clear all per-conversation storage keys and the quarantine.
 * Scans localStorage directly to catch orphaned keys not in the index.
 * Used as an emergency reset escape hatch.
 */
export function clearAllConversationStorage(): void {
  // Scan for all conv-data-* and conv-folder-* keys (including orphans)
  const allKeys = scanAllConversationKeys();
  for (const key of allKeys) {
    localStorage.removeItem(key);
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
    // v5 index (may be missing or corrupted)
    data[INDEX_KEY] = localStorage.getItem(INDEX_KEY);

    // Always scan for all conv-data-*/conv-folder-* keys (catches orphans too)
    const allKeys = scanAllConversationKeys();
    for (const key of allKeys) {
      data[key] = localStorage.getItem(key);
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
