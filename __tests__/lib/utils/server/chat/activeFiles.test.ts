import { computeActiveFilePerTurnBudget } from '@/lib/utils/server/chat/activeFiles';

import {
  ACTIVE_FILE_PER_TURN_MAX,
  ACTIVE_FILE_PER_TURN_MIN,
} from '@/lib/constants/activeFileQuotas';
import { describe, expect, it } from 'vitest';

describe('computeActiveFilePerTurnBudget', () => {
  it('scales with the model context window (128k / 16k output)', () => {
    // (128000 - 16000) * 0.25 = 28000, under the MAX cap
    expect(
      computeActiveFilePerTurnBudget({
        maxLength: 128_000,
        tokenLimit: 16_000,
      }),
    ).toBe(28_000);
  });

  it('clamps to ACTIVE_FILE_PER_TURN_MAX for very large context windows', () => {
    // (200000 - 32000) * 0.25 = 42000 → clamped to 40000
    expect(
      computeActiveFilePerTurnBudget({
        maxLength: 200_000,
        tokenLimit: 32_000,
      }),
    ).toBe(ACTIVE_FILE_PER_TURN_MAX);
  });

  it('falls back to ACTIVE_FILE_PER_TURN_MIN for legacy small-context models', () => {
    // (8000 - 4000) * 0.25 = 1000 → raised to MIN floor
    expect(
      computeActiveFilePerTurnBudget({ maxLength: 8_000, tokenLimit: 4_000 }),
    ).toBe(ACTIVE_FILE_PER_TURN_MIN);
  });

  it('returns the MIN floor when model metadata is missing or nonsensical', () => {
    expect(computeActiveFilePerTurnBudget(undefined)).toBe(
      ACTIVE_FILE_PER_TURN_MIN,
    );
    expect(computeActiveFilePerTurnBudget(null)).toBe(ACTIVE_FILE_PER_TURN_MIN);
    expect(
      computeActiveFilePerTurnBudget({ maxLength: 0, tokenLimit: 0 }),
    ).toBe(ACTIVE_FILE_PER_TURN_MIN);
    // tokenLimit >= maxLength leaves no input headroom
    expect(
      computeActiveFilePerTurnBudget({ maxLength: 1_000, tokenLimit: 2_000 }),
    ).toBe(ACTIVE_FILE_PER_TURN_MIN);
  });
});
