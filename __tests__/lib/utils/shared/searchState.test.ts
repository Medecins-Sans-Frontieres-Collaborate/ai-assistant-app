import {
  SEARCH_STATE_RECORD_NAME,
  decodeSearchState,
  encodeSearchState,
  isContinuableSearchState,
} from '@/lib/utils/shared/searchState';

import { describe, expect, it } from 'vitest';

const state = {
  question: 'Is the Winter Soldier documentary available to stream?',
  queries: ['Winter Soldier documentary stream'],
  strategies: ['terms' as const],
  deadEndStrategies: ['terms' as const],
  pagesTried: [],
  outcome: 'limit' as const,
  reason: 'no listing found',
  steps: [
    {
      kind: 'search' as const,
      detail: '"Winter Soldier documentary stream"',
      outcome: '4 results',
    },
  ],
};

describe('search state carrier', () => {
  it('round-trips through a tool record’s arguments', () => {
    const decoded = decodeSearchState({
      name: SEARCH_STATE_RECORD_NAME,
      arguments: encodeSearchState(state),
    });
    expect(decoded).toEqual(state);
    expect(isContinuableSearchState(decoded)).toBe(true);
  });

  it('ignores other records, malformed JSON and unknown shapes', () => {
    expect(
      decodeSearchState({ name: 'code_interpreter', arguments: '{}' }),
    ).toBeNull();
    expect(
      decodeSearchState({
        name: SEARCH_STATE_RECORD_NAME,
        arguments: '{"query":"x"}',
      }),
    ).toBeNull();
    expect(
      decodeSearchState({
        name: SEARCH_STATE_RECORD_NAME,
        arguments: 'not json',
      }),
    ).toBeNull();
    expect(
      decodeSearchState({
        name: SEARCH_STATE_RECORD_NAME,
        arguments: JSON.stringify({
          searchState: { ...state, outcome: 'exploded' },
        }),
      }),
    ).toBeNull();
  });

  it('only searches that ended short can be continued', () => {
    expect(isContinuableSearchState({ ...state, outcome: 'answered' })).toBe(
      false,
    );
    expect(isContinuableSearchState({ ...state, outcome: 'ask_user' })).toBe(
      false,
    );
    expect(isContinuableSearchState({ ...state, outcome: 'gave_up' })).toBe(
      true,
    );
    expect(isContinuableSearchState({ ...state, outcome: 'degraded' })).toBe(
      true,
    );
    expect(isContinuableSearchState(null)).toBe(false);
  });
});
