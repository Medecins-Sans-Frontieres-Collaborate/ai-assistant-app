import { useChatStore } from '@/client/stores/chatStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Unit tests for `lastTurnDroppedActiveFileIds` state on chatStore.
 *
 * The setter has a delete-on-empty branch — passing `[]` should *remove*
 * the conversation's key from the map rather than store an empty array.
 * Without that test, a future refactor could regress the cleanup and
 * leave stale empty arrays accumulating across many conversations.
 */
describe('ChatStore - lastTurnDroppedActiveFileIds', () => {
  beforeEach(() => {
    useChatStore.setState({ lastTurnDroppedActiveFileIds: {} });
  });

  it('stores file IDs under the conversation key', () => {
    useChatStore
      .getState()
      .setLastTurnDroppedActiveFileIds('conv-1', ['file-a', 'file-b']);

    expect(
      useChatStore.getState().lastTurnDroppedActiveFileIds['conv-1'],
    ).toEqual(['file-a', 'file-b']);
  });

  it('removes the conversation key when called with an empty array', () => {
    const store = useChatStore.getState();
    store.setLastTurnDroppedActiveFileIds('conv-1', ['file-a']);
    expect(useChatStore.getState().lastTurnDroppedActiveFileIds).toHaveProperty(
      'conv-1',
    );

    store.setLastTurnDroppedActiveFileIds('conv-1', []);

    // Empty array should *delete* the key, not store `[]`. This keeps the
    // map from accumulating stale empty entries across many conversations.
    expect(
      useChatStore.getState().lastTurnDroppedActiveFileIds,
    ).not.toHaveProperty('conv-1');
  });

  it('does not affect other conversations when one is cleared', () => {
    const store = useChatStore.getState();
    store.setLastTurnDroppedActiveFileIds('conv-1', ['a']);
    store.setLastTurnDroppedActiveFileIds('conv-2', ['b']);

    store.setLastTurnDroppedActiveFileIds('conv-1', []);

    const state = useChatStore.getState().lastTurnDroppedActiveFileIds;
    expect(state).not.toHaveProperty('conv-1');
    expect(state['conv-2']).toEqual(['b']);
  });
});
