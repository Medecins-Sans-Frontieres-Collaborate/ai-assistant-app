/**
 * Where a memory's current text came from. 'user' entries were written or
 * edited by hand in Settings and are protected: extraction may read them as
 * context but never rewrites or deletes them.
 */
export type MemoryOrigin = 'auto' | 'user';

/** A single long-term user fact stored by the Memories feature. */
export interface MemoryEntry {
  id: string; // uuid
  text: string;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
  /** Conversation the fact was extracted from (absent for manual edits). */
  sourceConversationId?: string;
  /**
   * Absent on entries written before manual editing shipped, and on every
   * auto-extracted entry — absent is read as 'auto' everywhere, which is why
   * adding this needed no memory-storage version bump.
   */
  origin?: MemoryOrigin;
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
