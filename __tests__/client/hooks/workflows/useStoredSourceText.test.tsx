import { act, renderHook } from '@testing-library/react';

import {
  SOURCE_TEXT_STORE_DELAY_MS,
  resetStoredSourceText,
  useStoredSourceText,
} from '@/client/hooks/workflows/useStoredSourceText';

import { RunMissingError } from '@/client/services/workflows/nativeRunStorage';
import {
  deleteSourceText,
  loadSourceText,
  storeSourceText,
  touchSourceText,
} from '@/client/services/workflows/storedSourceText';

import { RUN_KEEP_ALIVE_INTERVAL_MS } from '@/lib/utils/shared/translation/nativeRunStorage';
import {
  STORED_SOURCE_TEXT_MIN_CHARS,
  StoredSourceTextRef,
  sourceTextFingerprint,
} from '@/lib/utils/shared/translation/storedSourceText';

import { Conversation } from '@/types/chat';
import { TranslationWorkflowState } from '@/types/workflow';

import { useConversationStore } from '@/client/stores/conversationStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/client/services/workflows/storedSourceText', async (original) => ({
  ...(await original<
    typeof import('@/client/services/workflows/storedSourceText')
  >()),
  storeSourceText: vi.fn(),
  loadSourceText: vi.fn(),
  touchSourceText: vi.fn(),
  deleteSourceText: vi.fn(),
}));

const ID = '11111111-2222-4333-8444-555555555555';
const LARGE = 'a'.repeat(STORED_SOURCE_TEXT_MIN_CHARS);
const ALMOST = 'a'.repeat(STORED_SOURCE_TEXT_MIN_CHARS - 1);
const refFor = (
  text: string,
  extra: Partial<StoredSourceTextRef> = {},
): StoredSourceTextRef => ({
  id: ID,
  backend: 'app',
  fingerprint: sourceTextFingerprint(text),
  ...extra,
});

function seed(state: Partial<TranslationWorkflowState>) {
  useConversationStore.setState({
    conversations: [
      {
        id: 'c1',
        name: 'Translation',
        messages: [],
        conversationType: 'translation',
        updatedAt: '2026-11-18T10:00:00.000Z',
        workflowState: {
          kind: 'translation',
          sourceText: '',
          mode: 'quick',
          rounds: [],
          updatedAt: '2026-11-18T10:00:00.000Z',
          ...state,
        },
      } as unknown as Conversation,
    ],
  });
}
const conversation = () => useConversationStore.getState().conversations[0];
const stateNow = () => conversation().workflowState as TranslationWorkflowState;
const edit = (patch: Partial<TranslationWorkflowState>) =>
  act(() =>
    useConversationStore.getState().updateWorkflowState('c1', (previous) => ({
      ...(previous as TranslationWorkflowState),
      ...patch,
      updatedAt: new Date().toISOString(),
    })),
  );
/** The hook as the workspace uses it: fed the store's state. */
const mount = () =>
  renderHook(() =>
    useStoredSourceText({
      conversationId: 'c1',
      state: useConversationStore(
        (store) =>
          store.conversations[0]?.workflowState as TranslationWorkflowState,
      ),
      backend: 'app',
    }),
  );
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetStoredSourceText();
  localStorage.clear();
  vi.mocked(storeSourceText).mockImplementation(async (text) => refFor(text));
  vi.mocked(touchSourceText).mockResolvedValue(undefined);
  vi.mocked(deleteSourceText).mockResolvedValue(true);
});
afterEach(() => vi.useRealTimers());

describe('a text that becomes large', () => {
  it('is saved to storage after a quiet moment, at the threshold and not below', async () => {
    seed({ sourceText: ALMOST });
    mount();
    await advance(SOURCE_TEXT_STORE_DELAY_MS * 2);
    expect(storeSourceText).not.toHaveBeenCalled();

    edit({ sourceText: LARGE });
    await advance(SOURCE_TEXT_STORE_DELAY_MS - 1);
    expect(storeSourceText).not.toHaveBeenCalled();
    await advance(1);
    expect(storeSourceText).toHaveBeenCalledWith(LARGE, 'app', undefined);
    expect(stateNow().sourceTextRef).toEqual(refFor(LARGE));
    // In memory the text is still there; the browser's copy is not.
    expect(stateNow().sourceText).toBe(LARGE);
    const kept = JSON.parse(localStorage.getItem('conv-data-c1')!);
    expect(kept.workflowState.sourceText).toBe('');
  });

  it('waits for typing to stop, then saves the last text over the first', async () => {
    seed({ sourceText: LARGE, sourceTextRef: refFor(LARGE) });
    mount();
    await advance(SOURCE_TEXT_STORE_DELAY_MS);
    expect(storeSourceText).not.toHaveBeenCalled();

    edit({ sourceText: `${LARGE}b` });
    await advance(SOURCE_TEXT_STORE_DELAY_MS - 1);
    edit({ sourceText: `${LARGE}bc` });
    await advance(SOURCE_TEXT_STORE_DELAY_MS - 1);
    expect(storeSourceText).not.toHaveBeenCalled();
    await advance(1);
    expect(storeSourceText).toHaveBeenCalledTimes(1);
    expect(storeSourceText).toHaveBeenCalledWith(
      `${LARGE}bc`,
      'app',
      refFor(LARGE),
    );
  });

  it('stays in the browser when storage refuses it', async () => {
    vi.mocked(storeSourceText).mockRejectedValue(new Error('offline'));
    seed({ sourceText: LARGE });
    mount();
    await advance(SOURCE_TEXT_STORE_DELAY_MS);
    expect(stateNow().sourceTextRef).toBeUndefined();
    edit({ finalText: 'x' });
    const kept = JSON.parse(localStorage.getItem('conv-data-c1')!);
    expect(kept.workflowState.sourceText).toBe(LARGE);
  });

  it('is saved once when the workspace is mounted twice', async () => {
    seed({ sourceText: LARGE });
    mount();
    mount();
    await advance(SOURCE_TEXT_STORE_DELAY_MS);
    expect(storeSourceText).toHaveBeenCalledTimes(1);
  });

  it('goes back to the browser when it is cut short', async () => {
    seed({ sourceText: LARGE, sourceTextRef: refFor(LARGE) });
    mount();
    edit({ sourceText: ALMOST });
    expect(stateNow().sourceTextRef).toBeUndefined();
    expect(deleteSourceText).toHaveBeenCalledWith(refFor(LARGE));
    const kept = JSON.parse(localStorage.getItem('conv-data-c1')!);
    expect(kept.workflowState.sourceText).toBe(ALMOST);
  });
});

describe('a text the browser did not keep', () => {
  const waiting = () =>
    seed({ sourceTextRef: refFor(LARGE, { detached: true }) });

  it('is fetched once and put back without counting as an edit', async () => {
    vi.mocked(loadSourceText).mockResolvedValue(LARGE);
    vi.mocked(touchSourceText).mockResolvedValue('2026-11-22T00:00:00.000Z');
    waiting();
    const first = mount();
    mount();
    expect(first.result.current.loading).toBe(true);
    await advance(0);
    expect(loadSourceText).toHaveBeenCalledTimes(1);
    expect(stateNow().sourceText).toBe(LARGE);
    expect(stateNow().sourceTextRef?.detached).toBeUndefined();
    expect(conversation().updatedAt).toBe('2026-11-18T10:00:00.000Z');
    expect(first.result.current.loading).toBe(false);
    // Only asked when it expires; nothing is saved again.
    expect(touchSourceText).toHaveBeenCalledWith(expect.anything(), false);
    expect(first.result.current.expiresAt).toBe('2026-11-22T00:00:00.000Z');
    await advance(SOURCE_TEXT_STORE_DELAY_MS);
    expect(storeSourceText).not.toHaveBeenCalled();
  });

  it('says so when it is gone, and can be given up', async () => {
    vi.mocked(loadSourceText).mockRejectedValue(new RunMissingError());
    waiting();
    const { result } = mount();
    await advance(0);
    expect(result.current.problem).toBe('missing');
    expect(result.current.loading).toBe(false);
    act(() => result.current.forget());
    expect(stateNow().sourceTextRef).toBeUndefined();
    expect(result.current.problem).toBeNull();
  });

  it('can be tried again after a failure', async () => {
    vi.mocked(loadSourceText).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(loadSourceText).mockResolvedValue(LARGE);
    waiting();
    const { result } = mount();
    await advance(0);
    expect(result.current.problem).toBe('failed');
    act(() => result.current.retry());
    await advance(0);
    expect(result.current.problem).toBeNull();
    expect(stateNow().sourceText).toBe(LARGE);
  });
});

describe('keeping a stored text alive', () => {
  const stored = () =>
    seed({ sourceText: LARGE, sourceTextRef: refFor(LARGE) });

  it('touches it when the conversation is worked on, not when it is opened', async () => {
    stored();
    mount();
    await advance(SOURCE_TEXT_STORE_DELAY_MS);
    expect(touchSourceText).not.toHaveBeenCalled();
    edit({ finalText: 'first' });
    await advance(0);
    expect(touchSourceText).toHaveBeenCalledTimes(1);
    expect(touchSourceText).toHaveBeenCalledWith(refFor(LARGE));
  });

  it('touches it again only after the interval', async () => {
    stored();
    mount();
    edit({ finalText: 'first' });
    await advance(RUN_KEEP_ALIVE_INTERVAL_MS - 1000);
    edit({ finalText: 'second' });
    await advance(0);
    expect(touchSourceText).toHaveBeenCalledTimes(1);
    await advance(1000);
    edit({ finalText: 'third' });
    await advance(0);
    expect(touchSourceText).toHaveBeenCalledTimes(2);
  });

  it('keeps it on request and reports the new expiry', async () => {
    vi.mocked(touchSourceText).mockResolvedValue('2026-11-23T00:00:00.000Z');
    stored();
    const { result } = mount();
    await act(() => result.current.keep());
    expect(result.current.expiresAt).toBe('2026-11-23T00:00:00.000Z');
  });

  it('puts the text back in the browser when the stored copy has vanished', async () => {
    vi.mocked(touchSourceText).mockRejectedValue(new RunMissingError());
    stored();
    mount();
    edit({ finalText: 'first' });
    await advance(0);
    expect(stateNow().sourceTextRef).toBeUndefined();
    expect(stateNow().sourceText).toBe(LARGE);
    // And it is saved anew, to a new place.
    await advance(SOURCE_TEXT_STORE_DELAY_MS);
    expect(storeSourceText).toHaveBeenCalledWith(LARGE, 'app', undefined);
  });
});
