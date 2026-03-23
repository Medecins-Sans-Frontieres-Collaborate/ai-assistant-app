/**
 * Quarantine Store
 *
 * Manages quarantined conversation data in localStorage.
 * Corrupted conversations are stored here instead of being deleted,
 * preserving the raw data for potential recovery.
 */
import { QuarantinedItem } from '@/types/storage';

import { tryParseJSON } from './conversationValidator';

const QUARANTINE_KEY = 'conv-quarantine';

/**
 * Read all quarantined items from localStorage.
 */
export function getQuarantinedItems(): QuarantinedItem[] {
  try {
    const raw = localStorage.getItem(QUARANTINE_KEY);
    if (!raw) return [];
    const result = tryParseJSON<QuarantinedItem[]>(raw);
    return Array.isArray(result.data) ? result.data : [];
  } catch {
    return [];
  }
}

/**
 * Add a conversation to quarantine.
 * Preserves the raw data string as-is for maximum recoverability.
 * Returns true if the data was successfully quarantined, false if the write failed.
 * Callers should only delete source data if this returns true.
 */
export function quarantineConversation(
  rawData: string,
  errors: string[],
  sourceKey: string,
): boolean {
  try {
    const items = getQuarantinedItems();

    // Try to extract the id from the raw data for deduplication
    let id: string;
    try {
      const parsed = JSON.parse(rawData);
      id =
        typeof parsed?.id === 'string'
          ? parsed.id
          : globalThis.crypto.randomUUID();
    } catch {
      id = globalThis.crypto.randomUUID();
    }

    // Don't add duplicate entries for the same id (treat as success — data already preserved)
    if (items.some((item) => item.id === id)) {
      return true;
    }

    const item: QuarantinedItem = {
      id,
      rawData,
      errors,
      quarantinedAt: new Date().toISOString(),
      sourceKey,
      recoveryAttempted: false,
    };

    items.push(item);
    localStorage.setItem(QUARANTINE_KEY, JSON.stringify(items));
    return true;
  } catch (e) {
    console.error('[QuarantineStore] Failed to quarantine conversation:', e);
    return false;
  }
}

/**
 * Remove a single quarantined item by id.
 */
export function removeQuarantinedItem(id: string): void {
  try {
    const items = getQuarantinedItems();
    const filtered = items.filter((item) => item.id !== id);
    localStorage.setItem(QUARANTINE_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.error('[QuarantineStore] Failed to remove quarantined item:', e);
  }
}

/**
 * Mark a quarantined item as having had a recovery attempt.
 */
export function markRecoveryAttempted(id: string): void {
  try {
    const items = getQuarantinedItems();
    const updated = items.map((item) =>
      item.id === id ? { ...item, recoveryAttempted: true } : item,
    );
    localStorage.setItem(QUARANTINE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('[QuarantineStore] Failed to mark recovery attempted:', e);
  }
}

/**
 * Clear all quarantined items.
 */
export function clearAllQuarantined(): void {
  try {
    localStorage.removeItem(QUARANTINE_KEY);
  } catch (e) {
    console.error('[QuarantineStore] Failed to clear quarantine:', e);
  }
}

/**
 * Get the count of quarantined items (without parsing all data).
 */
export function getQuarantinedCount(): number {
  return getQuarantinedItems().length;
}
