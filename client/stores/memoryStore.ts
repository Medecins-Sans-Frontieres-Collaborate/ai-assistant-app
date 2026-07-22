'use client';

import { MemoryEntry, MemoryOperation } from '@/types/memory';

import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// Re-exported so the extraction service can import store + type together.
export type { MemoryOperation } from '@/types/memory';

/**
 * Dedicated persisted store for the Memories feature (cross-conversation
 * user facts injected into the system prompt). Deliberately NOT part of
 * settingsStore — and, like backupStore, deliberately excluded from the
 * settings export/import path: memories are personal, device-scoped data
 * that must not silently travel onto another device (importExport.ts
 * enumerates stores explicitly, so a new store is excluded by default).
 */

/** Hard cap on stored memories; exceeding it drops the oldest by updatedAt. */
const MAX_MEMORIES = 100;
/** Matches the server-side per-memory cap (ChatBodySchema: 600 chars). */
export const MAX_MEMORY_TEXT_LENGTH = 600;

interface MemoryStore {
  // Persisted state
  memories: MemoryEntry[];

  // Runtime-only state (not persisted)
  /**
   * Monotonically-increasing counter bumped by clearMemories. In-flight
   * extraction requests snapshot it before fetching and drop their result
   * if it changed, so a clear-all can never be undone by a late response.
   */
  clearGeneration: number;

  // Actions
  addMemory: (text: string, sourceConversationId?: string) => void;
  updateMemory: (id: string, text: string) => void;
  deleteMemory: (id: string) => void;
  clearMemories: () => void;
  /**
   * Applies extraction-endpoint operations in order. Malformed ops (missing
   * id/text) and updates targeting unknown ids are silently ignored — the
   * model output is best-effort, never trusted to be well-formed.
   */
  applyOperations: (
    ops: MemoryOperation[],
    sourceConversationId?: string,
  ) => void;
}

// Interior whitespace is collapsed so a memory can never span multiple
// lines — multi-line text could forge markdown sections once rendered as a
// bullet inside the system prompt.
const normalizeText = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_TEXT_LENGTH);

/** Enforces MAX_MEMORIES, dropping the oldest by updatedAt (order kept). */
const capMemories = (memories: MemoryEntry[]): MemoryEntry[] => {
  if (memories.length <= MAX_MEMORIES) return memories;
  const oldestFirst = [...memories].sort((a, b) =>
    (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''),
  );
  const droppedIds = new Set(
    oldestFirst.slice(0, memories.length - MAX_MEMORIES).map((m) => m.id),
  );
  return memories.filter((m) => !droppedIds.has(m.id));
};

export const useMemoryStore = create<MemoryStore>()(
  persist(
    (set, get) => ({
      // Persisted state
      memories: [],

      // Runtime-only state
      clearGeneration: 0,

      // Actions
      addMemory: (text, sourceConversationId) =>
        set((state) => {
          const trimmed = normalizeText(text);
          if (!trimmed) return state;
          const now = new Date().toISOString();
          const entry: MemoryEntry = {
            id: uuidv4(),
            text: trimmed,
            createdAt: now,
            updatedAt: now,
            ...(sourceConversationId ? { sourceConversationId } : {}),
          };
          return { memories: capMemories([...state.memories, entry]) };
        }),

      updateMemory: (id, text) =>
        set((state) => {
          const trimmed = normalizeText(text);
          if (!trimmed) return state;
          if (!state.memories.some((m) => m.id === id)) return state;
          return {
            memories: state.memories.map((m) =>
              m.id === id
                ? { ...m, text: trimmed, updatedAt: new Date().toISOString() }
                : m,
            ),
          };
        }),

      deleteMemory: (id) =>
        set((state) => ({
          memories: state.memories.filter((m) => m.id !== id),
        })),

      clearMemories: () =>
        set((state) => ({
          memories: [],
          clearGeneration: state.clearGeneration + 1,
        })),

      applyOperations: (ops, sourceConversationId) => {
        const { addMemory, updateMemory, deleteMemory } = get();
        for (const op of ops) {
          if (op.op === 'add' && op.text) {
            addMemory(op.text, sourceConversationId);
          } else if (op.op === 'update' && op.id && op.text) {
            updateMemory(op.id, op.text);
          } else if (op.op === 'delete' && op.id) {
            deleteMemory(op.id);
          }
        }
      },
    }),
    {
      name: 'memory-storage',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ memories: state.memories }),
      migrate: (persistedState) => {
        const state = persistedState as Record<string, unknown> | null;
        // Guard against corrupted storage — fall back to pristine defaults.
        if (
          !state ||
          typeof state !== 'object' ||
          !Array.isArray(state.memories)
        ) {
          return { memories: [] };
        }
        return state;
      },
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          console.error('[MemoryStore] Hydration error:', error);
          return;
        }
        if (state) {
          if (!Array.isArray(state.memories)) {
            state.memories = [];
          } else {
            // Drop malformed entries (partial writes / tampered storage) so
            // downstream `.map`/`.slice` never see them, then repair the
            // survivors: backfill missing timestamps (epoch-0 so backfilled
            // entries are evicted first at the cap — capMemories compares
            // updatedAt) and re-truncate over-length text so the store
            // invariant holds even for hand-edited storage (an over-length
            // memory would otherwise 400 every chat send server-side).
            const epoch = new Date(0).toISOString();
            state.memories = state.memories
              .filter(
                (m) =>
                  m != null &&
                  typeof m.id === 'string' &&
                  typeof m.text === 'string',
              )
              .map((m) => {
                const createdAt =
                  typeof m.createdAt === 'string' ? m.createdAt : epoch;
                return {
                  ...m,
                  text: m.text.slice(0, MAX_MEMORY_TEXT_LENGTH),
                  createdAt,
                  updatedAt:
                    typeof m.updatedAt === 'string' ? m.updatedAt : createdAt,
                };
              });
          }
        }
      },
    },
  ),
);
