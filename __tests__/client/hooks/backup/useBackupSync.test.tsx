import { act, renderHook } from '@testing-library/react';

import { useBackupSync } from '@/client/hooks/backup/useBackupSync';

import { getBackupKeys } from '@/client/services/backup/keystore';
import { runSync } from '@/lib/services/backup/syncEngine';
import type { SyncResult } from '@/lib/services/backup/types';

import { Conversation } from '@/types/chat';

import { useBackupStore } from '@/client/stores/backupStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { status: 'authenticated', data: {} as unknown },
}));

vi.mock('next-auth/react', () => ({
  useSession: () => mocks.session,
}));

vi.mock('@/lib/services/backup/syncEngine', () => ({
  runSync: vi.fn(
    async (): Promise<SyncResult> => ({
      status: 'ok',
      pushed: 0,
      pulled: 0,
      deleted: 0,
      conflictRetries: 0,
    }),
  ),
}));

vi.mock('@/client/services/backup/keystore', () => ({
  getBackupKeys: vi.fn(async () => ({
    encKey: { type: 'secret' } as unknown as CryptoKey,
    keyId: 'aabbccdd00112233',
  })),
}));

// The hook only reads isStreaming; a minimal store avoids dragging the full
// chat service graph into this test.
vi.mock('@/client/stores/chatStore', async () => {
  const { create } = await import('zustand');
  return { useChatStore: create(() => ({ isStreaming: false })) };
});

const runSyncMock = vi.mocked(runSync);
const getBackupKeysMock = vi.mocked(getBackupKeys);

const conv = (id: string): Conversation =>
  ({
    id,
    name: `Conv ${id}`,
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.7,
    folderId: null,
  }) as Conversation;

/** Flush pending microtasks (getBackupKeys/runSync promises) inside act. */
const flush = () => act(async () => {});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useBackupSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.session.status = 'authenticated';
    runSyncMock.mockClear();
    getBackupKeysMock.mockClear();
    getBackupKeysMock.mockResolvedValue({
      encKey: { type: 'secret' } as unknown as CryptoKey,
      keyId: 'aabbccdd00112233',
    });

    useBackupStore.setState({
      enrollmentStatus: 'enrolled',
      localKeyId: 'aabbccdd00112233',
      localKeyEpoch: 1,
      lastSyncedVersion: null,
      lastSyncedEtag: null,
      lastBackupAt: null,
      lastSyncError: null,
      syncStatus: 'idle',
      remoteExists: null,
      remoteKeyId: null,
      remoteKeyEpoch: null,
      flagEnabled: true,
      bannerCollapsed: false,
    });
    useConversationStore.setState({
      conversations: [],
      selectedConversationId: null,
      folders: [],
      searchTerm: '',
      isLoaded: true,
      deletedConversations: {},
      foldersUpdatedAt: null,
    });
    useChatStore.setState({ isStreaming: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('on-load gate', () => {
    it('runs the initial sync once everything is ready, and only once', async () => {
      const { rerender } = renderHook(() => useBackupSync());
      await flush();

      expect(runSyncMock).toHaveBeenCalledTimes(1);

      rerender();
      await flush();
      expect(runSyncMock).toHaveBeenCalledTimes(1);
    });

    it('waits for conversation rehydrate before the first sync', async () => {
      useConversationStore.setState({ isLoaded: false });
      renderHook(() => useBackupSync());
      await flush();
      expect(runSyncMock).not.toHaveBeenCalled();

      act(() => {
        useConversationStore.getState().setIsLoaded(true);
      });
      await flush();
      expect(runSyncMock).toHaveBeenCalledTimes(1);
    });

    it('does not sync while the session is unauthenticated', async () => {
      mocks.session.status = 'loading';
      renderHook(() => useBackupSync());
      await flush();
      expect(runSyncMock).not.toHaveBeenCalled();
    });

    it('does not sync when not enrolled', async () => {
      useBackupStore.setState({ enrollmentStatus: 'declined' });
      renderHook(() => useBackupSync());
      await flush();
      expect(runSyncMock).not.toHaveBeenCalled();
    });

    it('skips the sync when the keystore holds no key', async () => {
      getBackupKeysMock.mockResolvedValue(null);
      renderHook(() => useBackupSync());
      await flush();
      expect(runSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('flag off ⇒ zero network', () => {
    it('never touches the engine when the flag is disabled', async () => {
      useBackupStore.setState({ flagEnabled: false });
      renderHook(() => useBackupSync());
      await flush();

      act(() => {
        useConversationStore.getState().addConversation(conv('a'));
      });
      await advance(60_000);

      expect(runSyncMock).not.toHaveBeenCalled();
      expect(getBackupKeysMock).not.toHaveBeenCalled();
    });
  });

  describe('debounced auto-push', () => {
    it('coalesces rapid changes into one trailing sync after 15s', async () => {
      renderHook(() => useBackupSync());
      await flush();
      runSyncMock.mockClear();

      act(() => {
        useConversationStore.getState().addConversation(conv('a'));
      });
      await advance(5_000);
      act(() => {
        useConversationStore.getState().addConversation(conv('b'));
      });
      await advance(5_000);
      act(() => {
        useConversationStore.getState().addConversation(conv('c'));
      });

      // 15s not yet elapsed since the LAST change.
      await advance(14_999);
      expect(runSyncMock).not.toHaveBeenCalled();

      await advance(1);
      expect(runSyncMock).toHaveBeenCalledTimes(1);
    });

    it('ignores changes to unrelated fields (search term, selection)', async () => {
      renderHook(() => useBackupSync());
      await flush();
      runSyncMock.mockClear();

      act(() => {
        useConversationStore.getState().setSearchTerm('query');
        useConversationStore.getState().selectConversation(null);
      });
      await advance(30_000);

      expect(runSyncMock).not.toHaveBeenCalled();
    });

    it('fires on tombstone changes (deletions must push too)', async () => {
      renderHook(() => useBackupSync());
      await flush();
      runSyncMock.mockClear();

      act(() => {
        useConversationStore.getState().deleteConversation('ghost');
      });
      await advance(15_000);

      expect(runSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('streaming deferral', () => {
    it('defers while streaming, re-checks every 5s, syncs when idle', async () => {
      renderHook(() => useBackupSync());
      await flush();
      runSyncMock.mockClear();

      act(() => {
        useChatStore.setState({ isStreaming: true });
        useConversationStore.getState().addConversation(conv('a'));
      });

      await advance(15_000);
      expect(runSyncMock).not.toHaveBeenCalled(); // deferred: streaming

      await advance(5_000);
      expect(runSyncMock).not.toHaveBeenCalled(); // still streaming

      act(() => {
        useChatStore.setState({ isStreaming: false });
      });
      await advance(5_000);
      expect(runSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncNow', () => {
    it('runs a sync and resolves the engine result', async () => {
      const { result } = renderHook(() => useBackupSync());
      await flush();
      runSyncMock.mockClear();

      let outcome: SyncResult | null = null;
      await act(async () => {
        outcome = await result.current.syncNow();
      });

      expect(runSyncMock).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ status: 'ok' });
    });

    it('resolves null without engine calls when not ready', async () => {
      useBackupStore.setState({ flagEnabled: false });
      const { result } = renderHook(() => useBackupSync());
      await flush();

      let outcome: SyncResult | null = { status: 'ok' } as SyncResult;
      await act(async () => {
        outcome = await result.current.syncNow();
      });

      expect(outcome).toBeNull();
      expect(runSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('exposed state', () => {
    it('reflects syncStatus, lastBackupAt, and keyMismatch from the store', async () => {
      const { result } = renderHook(() => useBackupSync());
      await flush();

      act(() => {
        useBackupStore.getState().setSyncStatus('key-out-of-date');
        useBackupStore.setState({ lastBackupAt: '2026-07-17T10:00:00.000Z' });
      });

      expect(result.current.status).toBe('key-out-of-date');
      expect(result.current.keyMismatch).toBe(true);
      expect(result.current.lastBackupAt).toBe('2026-07-17T10:00:00.000Z');
    });

    it('records the engine error message on an error result', async () => {
      runSyncMock.mockResolvedValueOnce({
        status: 'error',
        pushed: 0,
        pulled: 0,
        deleted: 0,
        conflictRetries: 0,
        error: 'conflict persisted',
        errorCode: 'BACKUP_VERSION_CONFLICT',
      });

      renderHook(() => useBackupSync());
      await flush();

      expect(useBackupStore.getState().syncStatus).toBe('error');
      expect(useBackupStore.getState().lastSyncError).toBe(
        'conflict persisted',
      );
    });
  });
});
