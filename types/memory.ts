/** A single long-term user fact stored by the Memories feature. */
export interface MemoryEntry {
  id: string; // uuid
  text: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  /** Conversation the fact was extracted from (absent for manual edits). */
  sourceConversationId?: string;
}

/**
 * One mutation produced by the memory-extraction endpoint
 * (/api/chat/memories). `id` targets an existing entry for update/delete;
 * `text` carries the new content for add/update.
 */
export interface MemoryOperation {
  op: 'add' | 'update' | 'delete';
  id?: string;
  text?: string;
}
