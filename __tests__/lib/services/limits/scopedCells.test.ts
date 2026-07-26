import {
  resolveLimit,
  resolveModelCells,
} from '@/lib/services/limits/resolver';
import { LimitsPolicy, LimitsPolicySchema } from '@/lib/services/limits/types';
import { Principal } from '@/lib/services/shared/principalMatching';

import { getLimitDefinition } from '@/config/limits';
import { describe, expect, it } from 'vitest';

/**
 * The semantics the fine-grained admin UI promises an admin. If any of these
 * change, the ScopedLimitRows copy ("a family cap is an envelope, a model cap
 * a sub-cap") becomes a lie, which is the worst failure mode for this feature:
 * an admin believing a limit applies when it does not.
 */

const MODEL_REQUESTS = getLimitDefinition('model.requests')!;
const MODEL_ALLOWED = getLimitDefinition('model.allowed')!;

const principal: Principal = {
  userId: 'oid-1',
  mail: 'ada@example.org',
  domain: 'example.org',
  attributes: [],
  groupIds: [],
};

function policy(defaults: object[]): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults,
    overrides: [],
    updatedBy: 'admin',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('family and model cells compose conjunctively', () => {
  const p = policy([
    { limitKey: 'model.requests', series: 'gpt', value: 500 },
    { limitKey: 'model.requests', modelId: 'gpt-5.2', value: 50 },
  ]);

  it('produces BOTH a model cell and a family cell for a model with a series', () => {
    const cells = resolveModelCells(
      MODEL_REQUESTS,
      p,
      principal,
      'gpt-5.2',
      'gpt',
    );
    // Both must be checked — the model cap does not replace the family cap.
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ modelId: 'gpt-5.2', value: 50 });
    expect(cells[1]).toMatchObject({ series: 'gpt', value: 500 });
  });

  it('applies the family cap to a sibling model that has no cap of its own', () => {
    const cells = resolveModelCells(
      MODEL_REQUESTS,
      p,
      principal,
      'gpt-5.2-chat',
      'gpt',
    );
    const modelCell = cells.find((c) => c.modelId);
    const familyCell = cells.find((c) => c.series);
    // No model-specific entry → that cell falls through to unlimited…
    expect(modelCell?.value).toBeNull();
    // …but the envelope still binds.
    expect(familyCell?.value).toBe(500);
  });

  it('leaves an unrelated family untouched', () => {
    const cells = resolveModelCells(
      MODEL_REQUESTS,
      p,
      principal,
      'claude-opus-5',
      'claude',
    );
    expect(cells.every((c) => c.value === null)).toBe(true);
  });

  it('emits NO family cell for a model that declares no series', () => {
    const cells = resolveModelCells(
      MODEL_REQUESTS,
      p,
      principal,
      'gpt-5.2',
      undefined,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].series).toBeUndefined();
  });
});

describe('the seeding rule ScopedLimitRows depends on', () => {
  /**
   * Why a new scoped row is NEVER seeded at null: pickGlobalEntry ranks by
   * qualifier specificity BEFORE restrictiveness, so a family entry of null
   * outranks an unqualified number and silently un-limits the whole family.
   */
  it('a null family entry DOES defeat a stricter unqualified default', () => {
    const p = policy([
      { limitKey: 'model.requests', value: 100 },
      { limitKey: 'model.requests', series: 'gpt', value: null },
    ]);
    const familyCell = resolveLimit(
      MODEL_REQUESTS,
      p,
      principal,
      undefined,
      'gpt',
    );
    expect(familyCell.value).toBeNull();
  });

  it('a concrete seeded value does not un-limit anything', () => {
    const p = policy([
      { limitKey: 'model.requests', value: 100 },
      { limitKey: 'model.requests', series: 'gpt', value: 100 },
    ]);
    expect(
      resolveLimit(MODEL_REQUESTS, p, principal, undefined, 'gpt').value,
    ).toBe(100);
  });

  it('a boolean scoped row seeded blocked blocks exactly that model', () => {
    const p = policy([
      { limitKey: 'model.allowed', modelId: 'gpt-5.2', value: false },
    ]);
    expect(resolveLimit(MODEL_ALLOWED, p, principal, 'gpt-5.2').value).toBe(
      false,
    );
    expect(
      resolveLimit(MODEL_ALLOWED, p, principal, 'claude-opus-5').value,
    ).toBe(true);
  });
});

describe('an exact model qualifier outranks its family', () => {
  it('within the same layer, modelId wins over series', () => {
    const p = policy([
      { limitKey: 'model.requests', series: 'gpt', value: 500 },
      { limitKey: 'model.requests', modelId: 'gpt-5.2', value: 50 },
    ]);
    expect(resolveLimit(MODEL_REQUESTS, p, principal, 'gpt-5.2').value).toBe(
      50,
    );
  });
});
