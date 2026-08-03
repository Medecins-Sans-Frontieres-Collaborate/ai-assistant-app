/**
 * Sync-engine tests: push debounce with the If-Match guard, conflict on a
 * 412, and the pull poll's remote-change detection. m365Client is mocked;
 * timers are fake; binding writes land in the real conversation store.
 */
import { act, renderHook } from '@testing-library/react';

import { useM365DocSync } from '@/client/hooks/workflows/useM365DocSync';

import {
  M365ClientError,
  getDriveItemMeta,
  updateDriveItemContent,
} from '@/client/services/m365/m365Client';

import { Conversation } from '@/types/chat';
import { DocumentWorkflowState, M365DocumentBinding } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/m365/m365Client', () => ({
  M365ClientError: class M365ClientError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'M365ClientError';
      this.code = code;
    }
  },
  getDriveItemMeta: vi.fn(),
  updateDriveItemContent: vi.fn(),
  downloadDriveItem: vi.fn(),
  saveToOneDrive: vi.fn(),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

const CONVERSATION_ID = 'doc-1';

function makeBinding(
  overrides: Partial<M365DocumentBinding> = {},
): M365DocumentBinding {
  return {
    driveId: 'd1',
    itemId: 'i1',
    fileName: 'report.md',
    webUrl: 'https://contoso-my.sharepoint.com/report.md',
    format: 'md',
    lastSyncedETag: '"e1"',
    lastSyncedAt: new Date().toISOString(),
    autoPush: true,
    ...overrides,
  };
}

function makeState(
  overrides: Partial<DocumentWorkflowState> = {},
): DocumentWorkflowState {
  return {
    kind: 'document',
    title: 'Report',
    docHtml: '<p>A</p>',
    references: [],
    revisions: [],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function seedStore(workflowState: DocumentWorkflowState) {
  const conversation = {
    id: CONVERSATION_ID,
    name: 'Report',
    messages: [],
    model: { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
    prompt: '',
    temperature: 0.5,
    folderId: null,
    conversationType: 'document',
    workflowState,
  } as unknown as Conversation;
  useConversationStore.setState({
    conversations: [conversation],
    folders: [],
    searchTerm: '',
    isLoaded: true,
  });
}

function storedState(): DocumentWorkflowState {
  return useConversationStore.getState().conversations[0]
    .workflowState as DocumentWorkflowState;
}

interface HookProps {
  state: DocumentWorkflowState;
  blocked?: boolean;
}

function renderSync(initial: HookProps) {
  const exportForBinding = vi
    .fn()
    .mockResolvedValue(new Blob(['# hi'], { type: 'text/markdown' }));
  const applyRemote = vi.fn().mockResolvedValue('<p>remote</p>');
  const view = renderHook(
    ({ state, blocked }: HookProps) =>
      useM365DocSync({
        conversationId: CONVERSATION_ID,
        state,
        blocked: blocked ?? false,
        exportForBinding,
        applyRemote,
      }),
    { initialProps: initial },
  );
  return { ...view, exportForBinding, applyRemote };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Quiet polls by default: remote matches the binding's eTag.
  vi.mocked(getDriveItemMeta).mockResolvedValue({
    name: 'report.md',
    eTag: '"e1"',
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useM365DocSync — push', () => {
  it('pushes only after the idle debounce, with the If-Match guard, and stores the new eTag', async () => {
    const clean = makeState({ m365Binding: makeBinding() });
    seedStore(clean);
    vi.mocked(updateDriveItemContent).mockResolvedValue({
      name: 'report.md',
      eTag: '"e2"',
    });
    const { rerender, exportForBinding } = renderSync({ state: clean });

    // No local dirt: nothing pushes no matter how long we wait.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(updateDriveItemContent).not.toHaveBeenCalled();

    rerender({ state: { ...clean, docHtml: '<p>B</p>' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6900);
    });
    expect(updateDriveItemContent).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(exportForBinding).toHaveBeenCalledWith('md');
    expect(updateDriveItemContent).toHaveBeenCalledTimes(1);
    expect(updateDriveItemContent).toHaveBeenCalledWith(
      expect.any(Blob),
      'report.md',
      { driveId: 'd1', itemId: 'i1', ifMatch: '"e1"' },
    );
    expect(storedState().m365Binding?.lastSyncedETag).toBe('"e2"');
  });

  it('never pushes while blocked (generation running / review edits pending)', async () => {
    const clean = makeState({ m365Binding: makeBinding() });
    seedStore(clean);
    const { rerender } = renderSync({ state: clean });
    rerender({ state: { ...clean, docHtml: '<p>B</p>' }, blocked: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(updateDriveItemContent).not.toHaveBeenCalled();
  });

  it('enters the conflict state when the guarded push comes back 412', async () => {
    const clean = makeState({ m365Binding: makeBinding() });
    seedStore(clean);
    vi.mocked(updateDriveItemContent).mockRejectedValue(
      new M365ClientError('conflict', 'M365_CONFLICT'),
    );
    const { result, rerender } = renderSync({ state: clean });
    rerender({ state: { ...clean, docHtml: '<p>B</p>' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7100);
    });
    expect(result.current.conflict).toBe(true);
    // The failed write must not advance the sync record.
    expect(storedState().m365Binding?.lastSyncedETag).toBe('"e1"');
  });
});

describe('useM365DocSync — pull', () => {
  it('shows the reload banner when the remote changed and there is no local dirt', async () => {
    const clean = makeState({ m365Binding: makeBinding({ autoPush: false }) });
    seedStore(clean);
    vi.mocked(getDriveItemMeta).mockResolvedValue({
      name: 'report.md',
      eTag: '"e9"',
    });
    const { result } = renderSync({ state: clean });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(getDriveItemMeta).toHaveBeenCalledWith(
      'd1',
      'i1',
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(result.current.remoteChanged).toBe(true);
    expect(result.current.conflict).toBe(false);
  });

  it('escalates to a conflict when the remote changed AND local edits exist', async () => {
    const clean = makeState({ m365Binding: makeBinding({ autoPush: false }) });
    seedStore(clean);
    vi.mocked(getDriveItemMeta).mockResolvedValue({
      name: 'report.md',
      eTag: '"e9"',
    });
    const { result, rerender } = renderSync({ state: clean });
    rerender({ state: { ...clean, docHtml: '<p>B</p>' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(result.current.conflict).toBe(true);
    expect(result.current.remoteChanged).toBe(false);
  });

  it('stays quiet while the remote eTag still matches', async () => {
    const clean = makeState({ m365Binding: makeBinding({ autoPush: false }) });
    seedStore(clean);
    const { result } = renderSync({ state: clean });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(getDriveItemMeta).toHaveBeenCalled();
    expect(result.current.remoteChanged).toBe(false);
    expect(result.current.conflict).toBe(false);
  });
});
