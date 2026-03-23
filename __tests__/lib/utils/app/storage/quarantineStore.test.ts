import {
  clearAllQuarantined,
  getQuarantinedCount,
  getQuarantinedItems,
  markRecoveryAttempted,
  quarantineConversation,
  removeQuarantinedItem,
} from '@/lib/utils/app/storage/quarantineStore';

import { afterEach, describe, expect, it } from 'vitest';

describe('quarantineStore', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no quarantined items', () => {
    expect(getQuarantinedItems()).toEqual([]);
    expect(getQuarantinedCount()).toBe(0);
  });

  it('quarantines a conversation', () => {
    quarantineConversation(
      '{"id": "conv-1", "broken": true}',
      ['Missing name'],
      'conv-data-conv-1',
    );

    const items = getQuarantinedItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('conv-1');
    expect(items[0].errors).toEqual(['Missing name']);
    expect(items[0].sourceKey).toBe('conv-data-conv-1');
    expect(items[0].recoveryAttempted).toBe(false);
  });

  it('does not duplicate entries with same id', () => {
    quarantineConversation('{"id": "conv-1"}', ['error1'], 'source-1');
    quarantineConversation('{"id": "conv-1"}', ['error2'], 'source-2');

    expect(getQuarantinedItems()).toHaveLength(1);
  });

  it('generates UUID for unparseable data', () => {
    quarantineConversation('{broken json', ['parse error'], 'source');

    const items = getQuarantinedItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBeDefined();
    expect(items[0].rawData).toBe('{broken json');
  });

  it('removes a quarantined item', () => {
    quarantineConversation('{"id": "a"}', ['err'], 'src');
    quarantineConversation('{"id": "b"}', ['err'], 'src');

    removeQuarantinedItem('a');

    const items = getQuarantinedItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('b');
  });

  it('marks recovery attempted', () => {
    quarantineConversation('{"id": "conv-1"}', ['err'], 'src');

    markRecoveryAttempted('conv-1');

    const items = getQuarantinedItems();
    expect(items[0].recoveryAttempted).toBe(true);
  });

  it('clears all quarantined items', () => {
    quarantineConversation('{"id": "a"}', ['err'], 'src');
    quarantineConversation('{"id": "b"}', ['err'], 'src');

    clearAllQuarantined();

    expect(getQuarantinedItems()).toEqual([]);
    expect(getQuarantinedCount()).toBe(0);
  });
});
