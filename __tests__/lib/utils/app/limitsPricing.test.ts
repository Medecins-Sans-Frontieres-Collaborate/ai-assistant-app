import {
  CostCell,
  allowedModels,
  buildPricingIndex,
  ceilingSpendPerDay,
  familyRange,
  lookupPricing,
  modelRequestCost,
  spentSoFarUsd,
} from '@/lib/utils/app/limitsPricing';
import {
  COST_ASSUMPTIONS,
  blendedPerTokenUsd,
} from '@/lib/utils/shared/costEstimator';

import { OpenAIModel, OpenAIModels } from '@/types/openai';

import { describe, expect, it } from 'vitest';

/**
 * The limits adapter's contract (docs/LIMITS_COST_INSIGHTS_DESIGN.md §3a),
 * which MUST mirror enforcement (resolver.ts resolveModelCells /
 * pickGlobalEntry / entryAppliesTo — every expectation below was cross-checked
 * against min over those cells and checkGate): a case-insensitive pricing
 * index with static-registry fallback; a per-model key has TWO conjunctive
 * cells — the MODEL cell and (only with a `series`) the FAMILY cell — each
 * resolved qualified-else-unqualified, draft first and the global defaults
 * second, so an unqualified entry is a shadowed fallback inside each cell and
 * never a third cap; a family cell is ONE shared counter (an envelope spent
 * on the dearest members), never a per-member allowance; the per-day ceiling
 * is the MIN over conjunctive axes (never a sum), with the models axis
 * bounded only when EVERY allowed model is capped; and "spent so far" picks
 * its basis from whichever counters exist, pricing tokens at the highest
 * blended rate among the allowed models (the token-cap hint's rule).
 */

function model(partial: Partial<OpenAIModel> & { id: string }): OpenAIModel {
  return {
    name: partial.id,
    maxLength: 0,
    tokenLimit: 0,
    ...partial,
  } as OpenAIModel;
}

const TERRA = 'gpt-5.6-terra'; // $0.008 typical
const LUNA = 'gpt-5.6-luna'; // $0.0008 typical
const SOL = 'gpt-5.6-sol'; // $0.020 typical
const FABLE = 'claude-fable-5'; // $0.035 typical — declares NO series

/** A ring serving only the gpt-56 trio (with a byom and an agent that must be ignored). */
const RING: OpenAIModel[] = [
  OpenAIModels[TERRA],
  OpenAIModels[LUNA],
  OpenAIModels[SOL],
  model({
    id: 'byom-abc-gpt-5.6-terra',
    isCustomSourceModel: true,
    pricing: { inputPer1M: 1, outputPer1M: 1 },
  }),
  model({
    id: 'org-comms',
    modelType: 'agent',
    pricing: { inputPer1M: 1, outputPer1M: 1 },
  }),
  model({ id: 'synth-unpriced' }),
];

const cost = (id: string) =>
  modelRequestCost(lookupPricing(buildPricingIndex(RING), id)!, 'typical');

describe('buildPricingIndex', () => {
  const index = buildPricingIndex(RING);

  it('is keyed case-insensitively and marks ring-served models', () => {
    expect(lookupPricing(index, 'GPT-5.6-TERRA')).toMatchObject({
      id: TERRA,
      servedInRing: true,
    });
    expect(lookupPricing(index, TERRA)!.pricing.inputPer1M).toBe(2);
  });

  it('falls back to the static registry for ids this ring does not serve', () => {
    expect(lookupPricing(index, 'o3')).toMatchObject({
      id: 'o3',
      servedInRing: false,
    });
    expect(lookupPricing(index, 'GROK-4')).toMatchObject({ id: 'grok-4' });
  });

  it('leaves out byom, agent, and unpriced models', () => {
    expect(lookupPricing(index, 'byom-abc-gpt-5.6-terra')).toBeUndefined();
    expect(lookupPricing(index, 'org-comms')).toBeUndefined();
    expect(lookupPricing(index, 'synth-unpriced')).toBeUndefined();
  });

  it('prefers the served object over the static one for the same id', () => {
    const overlay = { ...OpenAIModels[TERRA], name: 'Terra (ring)' };
    const idx = buildPricingIndex([overlay]);
    expect(lookupPricing(idx, TERRA)!.model.name).toBe('Terra (ring)');
  });
});

describe('modelRequestCost', () => {
  it('prices a typical request at Global list rates by default', () => {
    expect(cost(TERRA).total).toBeCloseTo(0.008, 10);
    expect(cost(LUNA).total).toBeCloseTo(0.0008, 10);
    expect(cost(SOL).total).toBeCloseTo(0.02, 10);
  });

  it('applies the reasoner multiplier and an explicit deployment', () => {
    const index = buildPricingIndex(RING);
    expect(
      modelRequestCost(lookupPricing(index, 'o3')!, 'typical').total,
    ).toBeCloseTo(0.014, 10);
    expect(
      modelRequestCost(lookupPricing(index, TERRA)!, 'typical', {
        deployment: 'dataZone',
      }).total,
    ).toBeCloseTo(0.0088, 10);
  });
});

describe('allowedModels', () => {
  const index = buildPricingIndex([
    OpenAIModels[TERRA],
    OpenAIModels[LUNA],
    OpenAIModels['claude-haiku-4-5'],
  ]);
  const ids = (entries: ReturnType<typeof allowedModels>) =>
    entries.map((e) => e.id).sort();

  it('keeps every served model when nothing is disallowed', () => {
    expect(ids(allowedModels(index, []))).toEqual(
      [TERRA, LUNA, 'claude-haiku-4-5'].sort(),
    );
  });

  it('never includes static-fallback or disabled entries', () => {
    // o3 is priceable via the static registry but not served here.
    expect(lookupPricing(index, 'o3')).toBeDefined();
    expect(ids(allowedModels(index, []))).not.toContain('o3');
    const withDisabled = buildPricingIndex([
      OpenAIModels[TERRA],
      { ...OpenAIModels[SOL], isDisabled: true },
    ]);
    expect(ids(allowedModels(withDisabled, []))).toEqual([TERRA]);
  });

  it('drops a model disallowed at model level (case-insensitively)', () => {
    const draft: CostCell[] = [
      { limitKey: 'model.allowed', modelId: 'GPT-5.6-TERRA', value: false },
    ];
    expect(ids(allowedModels(index, draft))).toEqual(
      [LUNA, 'claude-haiku-4-5'].sort(),
    );
  });

  it('drops a whole family disallowed at family level', () => {
    const draft: CostCell[] = [
      { limitKey: 'model.allowed', series: 'gpt-56', value: false },
    ];
    expect(ids(allowedModels(index, draft))).toEqual(['claude-haiku-4-5']);
  });

  // Flipped from "a model-level allow wins over a family-level block": that
  // encoded shadowing, but enforcement (checkGate → resolveModelCells) ANDs
  // the model cell and the family cell — a series entry never competes in
  // the model cell, so terra's `true` cannot rescue the family's `false`.
  it('a family-level block is conjunctive: a model-level allow never rescues it', () => {
    const draft: CostCell[] = [
      { limitKey: 'model.allowed', series: 'gpt-56', value: false },
      { limitKey: 'model.allowed', modelId: TERRA, value: true },
    ];
    expect(ids(allowedModels(index, draft))).toEqual(['claude-haiku-4-5']);
  });

  it('an unqualified block reaches the family cell, which a model-level allow cannot shadow', () => {
    const withFable = buildPricingIndex([
      OpenAIModels[TERRA],
      OpenAIModels[LUNA],
      OpenAIModels[FABLE],
    ]);
    const draft: CostCell[] = [
      { limitKey: 'model.allowed', value: false },
      { limitKey: 'model.allowed', modelId: TERRA, value: true },
      { limitKey: 'model.allowed', modelId: FABLE, value: true },
    ];
    // terra: model cell true, family cell (gpt-56) falls back to the
    // unqualified false → blocked. fable has no series, so no family cell.
    expect(ids(allowedModels(withFable, draft))).toEqual([FABLE]);
  });

  it('ANDs the already-resolved rows /api/limits/me hands the preview', () => {
    // The route resolves each cell separately: the unqualified row, the
    // model row and the family row all arrive, and the family one blocks.
    const rows: CostCell[] = [
      { limitKey: 'model.allowed', value: true },
      { limitKey: 'model.allowed', modelId: TERRA, value: true },
      { limitKey: 'model.allowed', series: 'gpt-56', value: false },
    ];
    expect(ids(allowedModels(index, rows))).toEqual(['claude-haiku-4-5']);
  });

  it('consults the global defaults second, and the draft wins where it speaks', () => {
    const defaults: CostCell[] = [
      { limitKey: 'model.allowed', series: 'gpt-56', value: false },
      { limitKey: 'model.allowed', modelId: 'claude-haiku-4-5', value: false },
    ];
    // No defaults → nothing dropped (scoped mode never sees them).
    expect(ids(allowedModels(index, []))).toHaveLength(3);
    // Defaults alone drop the family and haiku.
    expect(ids(allowedModels(index, [], defaults))).toEqual([]);
    // Flipped from `[LUNA]`: a draft re-allowing luna at MODEL level speaks
    // only to luna's model cell; its family cell still resolves to the
    // defaults' `false`, and enforcement blocks on either cell.
    const modelDraft: CostCell[] = [
      { limitKey: 'model.allowed', modelId: LUNA, value: true },
    ];
    expect(ids(allowedModels(index, modelDraft, defaults))).toEqual([]);
    // Re-allowing the FAMILY in the draft is what lifts the block (the draft
    // layer wins the family cell); haiku stays blocked at model level.
    const familyDraft: CostCell[] = [
      { limitKey: 'model.allowed', series: 'gpt-56', value: true },
    ];
    expect(ids(allowedModels(index, familyDraft, defaults))).toEqual(
      [TERRA, LUNA].sort(),
    );
  });

  it('accepts the editors draft-key record form', () => {
    expect(
      ids(
        allowedModels(index, {
          [`model.allowed@model:${TERRA}`]: false,
          'model.allowed@family:claude': false,
          'chat.messagesPerDay': 10,
          'model.allowed@model:gpt-5.6-luna': undefined,
        }),
      ),
    ).toEqual([LUNA]);
  });

  it('ignores other keys and a `null` (unlimited) value', () => {
    const draft: CostCell[] = [
      { limitKey: 'model.requests', modelId: TERRA, value: 0 },
      { limitKey: 'model.allowed', modelId: LUNA, value: null },
    ];
    expect(ids(allowedModels(index, draft))).toHaveLength(3);
  });
});

describe('familyRange', () => {
  const index = buildPricingIndex(RING);

  it('spans the cheapest to the priciest enabled member', () => {
    const range = familyRange('GPT-56', index, 'typical');
    expect(range).not.toBeNull();
    expect(range!.min).toBeCloseTo(0.0008, 10);
    expect(range!.max).toBeCloseTo(0.02, 10);
    expect(range!.cheapestModelId).toBe(LUNA);
    expect(range!.priciestModelId).toBe(SOL);
    expect(range!.memberIds.sort()).toEqual([LUNA, SOL, TERRA].sort());
  });

  it('skips disabled members', () => {
    const idx = buildPricingIndex([
      OpenAIModels[TERRA],
      { ...OpenAIModels[SOL], isDisabled: true },
    ]);
    const range = familyRange('gpt-56', idx, 'typical');
    expect(range!.memberIds).toEqual([TERRA]);
    expect(range!.max).toBeCloseTo(0.008, 10);
  });

  it('is null — never a $0 range — for a series with no priced member', () => {
    expect(familyRange('no-such-series', index, 'typical')).toBeNull();
  });
});

describe('ceilingSpendPerDay', () => {
  // A ring of just terra + luna so the axes are hand-checkable.
  const index = buildPricingIndex([OpenAIModels[TERRA], OpenAIModels[LUNA]]);
  const TOKENS = 1500;

  it('is unbounded when nothing binds', () => {
    expect(ceilingSpendPerDay([], index, 'typical')).toEqual({
      bounded: false,
    });
    expect(
      ceilingSpendPerDay(
        [{ limitKey: 'chat.messagesPerDay', value: null }],
        index,
        'typical',
      ),
    ).toEqual({ bounded: false });
  });

  it('messages axis: cap × the priciest allowed request', () => {
    const ceiling = ceilingSpendPerDay(
      [{ limitKey: 'chat.messagesPerDay', value: 30 }],
      index,
      'typical',
    );
    expect(ceiling).toMatchObject({
      bounded: true,
      axis: 'messages',
      priciestModelId: TERRA,
    });
    if (!ceiling.bounded) return;
    expect(ceiling.usdPerDay).toBeCloseTo(30 * 0.008, 10);
  });

  it('messages axis follows the allowed set — disallowing the priciest lowers it', () => {
    const ceiling = ceilingSpendPerDay(
      [
        { limitKey: 'chat.messagesPerDay', value: 30 },
        { limitKey: 'model.allowed', modelId: TERRA, value: false },
      ],
      index,
      'typical',
    );
    if (!ceiling.bounded) throw new Error('expected bounded');
    expect(ceiling.priciestModelId).toBe(LUNA);
    expect(ceiling.usdPerDay).toBeCloseTo(30 * 0.0008, 10);
  });

  it('models axis binds only when EVERY allowed model is capped', () => {
    const partial = ceilingSpendPerDay(
      [{ limitKey: 'model.requests', modelId: TERRA, value: 50 }],
      index,
      'typical',
    );
    expect(partial).toEqual({ bounded: false });

    const full = ceilingSpendPerDay(
      [
        { limitKey: 'model.requests', modelId: TERRA, value: 50 },
        { limitKey: 'model.requests', modelId: LUNA, value: 100 },
      ],
      index,
      'typical',
    );
    if (!full.bounded) throw new Error('expected bounded');
    expect(full.axis).toBe('models');
    expect(full.usdPerDay).toBeCloseTo(50 * 0.008 + 100 * 0.0008, 10);
  });

  // Flipped from `10 × 0.008 + 10 × 0.0008`: that treated the family cap as
  // a per-member allowance, but `family:gpt-56.requests` is ONE shared
  // counter (resolver.ts counterCellName), so 10 requests across the family
  // spend at most 10 × the dearest member.
  it('models axis: a family cap is a shared envelope, spent on the dearest member', () => {
    const family = ceilingSpendPerDay(
      [{ limitKey: 'model.requests', series: 'gpt-56', value: 10 }],
      index,
      'typical',
    );
    if (!family.bounded) throw new Error('expected bounded');
    expect(family.axis).toBe('models');
    expect(family.usdPerDay).toBeCloseTo(10 * 0.008, 10);

    // Flipped from `5 × 0.008 + 10 × 0.0008` (which AND-ed the bare cell
    // and gave luna its own 10): terra's model cell is 5 (qualified shadows
    // the unqualified 100), luna's is 100 (unqualified fallback); the family
    // envelope of 10 goes to terra first (5), leaving 5 for luna.
    const conjunctive = ceilingSpendPerDay(
      [
        { limitKey: 'model.requests', value: 100 },
        { limitKey: 'model.requests', series: 'gpt-56', value: 10 },
        { limitKey: 'model.requests', modelId: TERRA, value: 5 },
      ],
      index,
      'typical',
    );
    if (!conjunctive.bounded) throw new Error('expected bounded');
    expect(conjunctive.usdPerDay).toBeCloseTo(5 * 0.008 + 5 * 0.0008, 10);
  });

  it('models axis: a family envelope counts once, never per member (would have overstated)', () => {
    const trio = buildPricingIndex([
      OpenAIModels[SOL],
      OpenAIModels[TERRA],
      OpenAIModels[LUNA],
    ]);
    const familyOnly = ceilingSpendPerDay(
      [{ limitKey: 'model.requests', series: 'gpt-56', value: 100 }],
      trio,
      'typical',
    );
    if (!familyOnly.bounded) throw new Error('expected bounded');
    // 100 × $0.02 (sol), not 100 × (0.02 + 0.008 + 0.0008) = $2.88.
    expect(familyOnly.usdPerDay).toBeCloseTo(100 * 0.02, 10);

    // A looser unqualified cap per member changes nothing: the envelope binds.
    const withUnqualified = ceilingSpendPerDay(
      [
        { limitKey: 'model.requests', value: 200 },
        { limitKey: 'model.requests', series: 'gpt-56', value: 100 },
      ],
      trio,
      'typical',
    );
    if (!withUnqualified.bounded) throw new Error('expected bounded');
    expect(withUnqualified.usdPerDay).toBeCloseTo(100 * 0.02, 10);

    // A tighter own cap on the dearest member pushes the rest of the
    // envelope down to the next-dearest: 10 × sol, then 90 × terra.
    const solCapped = ceilingSpendPerDay(
      [
        { limitKey: 'model.requests', series: 'gpt-56', value: 100 },
        { limitKey: 'model.requests', modelId: SOL, value: 10 },
      ],
      trio,
      'typical',
    );
    if (!solCapped.bounded) throw new Error('expected bounded');
    expect(solCapped.usdPerDay).toBeCloseTo(10 * 0.02 + 90 * 0.008, 10);
  });

  it('models axis: a qualified cap RAISED above the unqualified default is used (case D)', () => {
    const withFable = buildPricingIndex([
      OpenAIModels[TERRA],
      OpenAIModels[LUNA],
      OpenAIModels[FABLE],
    ]);
    // The rows /api/limits/me builds: the bare default plus one resolved
    // row per mentioned qualifier. Enforcement caps terra/luna/fable at
    // 100/100/100 — the bare 5 is shadowed inside every cell, never a
    // third cap — so the ceiling is the family envelope (100 × terra) plus
    // fable's own 100, not the understated 5-per-model $0.219.
    const rows: CostCell[] = [
      { limitKey: 'model.requests', value: 5 },
      { limitKey: 'model.requests', series: 'gpt-56', value: 100 },
      { limitKey: 'model.requests', modelId: TERRA, value: 100 },
      { limitKey: 'model.requests', modelId: LUNA, value: 100 },
      { limitKey: 'model.requests', modelId: FABLE, value: 100 },
    ];
    const ceiling = ceilingSpendPerDay(rows, withFable, 'typical');
    if (!ceiling.bounded) throw new Error('expected bounded');
    expect(ceiling.axis).toBe('models');
    expect(ceiling.usdPerDay).toBeCloseTo(100 * 0.008 + 100 * 0.035, 10);
  });

  it('models axis: a model with no series has no family cell, so its raised cap stands (case D2)', () => {
    const fableOnly = buildPricingIndex([OpenAIModels[FABLE]]);
    const rows: CostCell[] = [
      { limitKey: 'model.requests', value: 5 },
      { limitKey: 'model.requests', modelId: FABLE, value: 100 },
    ];
    const ceiling = ceilingSpendPerDay(rows, fableOnly, 'typical');
    if (!ceiling.bounded) throw new Error('expected bounded');
    expect(ceiling.usdPerDay).toBeCloseTo(100 * 0.035, 10);

    // Same policy as draft-over-defaults (the editor's form): the draft's
    // model cell wins over the defaults' unqualified value.
    const draft = ceilingSpendPerDay(
      [{ limitKey: 'model.requests', modelId: FABLE, value: 100 }],
      fableOnly,
      'typical',
      [{ limitKey: 'model.requests', value: 5 }],
    );
    if (!draft.bounded) throw new Error('expected bounded');
    expect(draft.usdPerDay).toBeCloseTo(100 * 0.035, 10);

    // A qualified `null` (unlimited) shadows the unqualified number too:
    // enforcement has no cap, so neither may the ceiling (never understate).
    expect(
      ceilingSpendPerDay(
        [
          { limitKey: 'model.requests', value: 5 },
          { limitKey: 'model.requests', modelId: FABLE, value: null },
        ],
        fableOnly,
        'typical',
      ),
    ).toEqual({ bounded: false });
  });

  it('models axis: raising only the MODEL cell leaves the family cell on the unqualified cap (case E)', () => {
    // terra: model cell 100 (draft), family cell 5 (defaults' unqualified);
    // luna: model cell 5, family cell 5. The shared family envelope of 5 is
    // spent on terra → $0.04, exactly what enforcement lets through.
    const ceiling = ceilingSpendPerDay(
      [{ limitKey: 'model.requests', modelId: TERRA, value: 100 }],
      index,
      'typical',
      [{ limitKey: 'model.requests', value: 5 }],
    );
    if (!ceiling.bounded) throw new Error('expected bounded');
    expect(ceiling.usdPerDay).toBeCloseTo(5 * 0.008, 10);
  });

  it('is $0 on the blocked axis when a model-level allow is overruled by a family block', () => {
    // Enforcement blocks every gpt-56 model here (family cell false); the
    // card must not price terra as allowed and report a "messages" ceiling.
    const ceiling = ceilingSpendPerDay(
      [
        { limitKey: 'model.allowed', series: 'gpt-56', value: false },
        { limitKey: 'model.allowed', modelId: TERRA, value: true },
        { limitKey: 'chat.messagesPerDay', value: 30 },
      ],
      index,
      'typical',
    );
    expect(ceiling).toMatchObject({
      bounded: true,
      usdPerDay: 0,
      axis: 'blocked',
      priciestModelId: null,
    });
  });

  it('tokens axis: ceil(cap / tokens per request) × request cost, dearest model', () => {
    const ceiling = ceilingSpendPerDay(
      [{ limitKey: 'chat.tokensPerDay', value: 10_000 }],
      index,
      'typical',
    );
    if (!ceiling.bounded) throw new Error('expected bounded');
    expect(ceiling.axis).toBe('tokens');
    expect(ceiling.usdPerDay).toBeCloseTo(
      Math.ceil(10_000 / TOKENS) * 0.008,
      10,
    );
    expect(ceiling.approximateMonthConversion).toBe(false);
  });

  it('tokens axis: the calendar-month cap converts at 30.4375 days and is flagged', () => {
    const ceiling = ceilingSpendPerDay(
      [{ limitKey: 'chat.tokensPerMonth', value: 300_000 }],
      index,
      'typical',
    );
    if (!ceiling.bounded) throw new Error('expected bounded');
    expect(ceiling.axis).toBe('tokens');
    expect(ceiling.approximateMonthConversion).toBe(true);
    expect(ceiling.usdPerDay).toBeCloseTo(
      (Math.ceil(300_000 / TOKENS) * 0.008) / COST_ASSUMPTIONS.periodDays.month,
      10,
    );
  });

  it('takes the MIN over axes and never sums them', () => {
    const ceiling = ceilingSpendPerDay(
      [
        { limitKey: 'chat.messagesPerDay', value: 30 }, // $0.24
        { limitKey: 'model.requests', modelId: TERRA, value: 50 },
        { limitKey: 'model.requests', modelId: LUNA, value: 100 }, // $0.48
        { limitKey: 'chat.tokensPerDay', value: 10_000 }, // 7 × $0.008 = $0.056
      ],
      index,
      'typical',
    );
    if (!ceiling.bounded) throw new Error('expected bounded');
    expect(ceiling.axis).toBe('tokens');
    expect(ceiling.usdPerDay).toBeCloseTo(0.056, 10);
    expect(ceiling.axes.messages).toBeCloseTo(0.24, 10);
    expect(ceiling.axes.models).toBeCloseTo(0.48, 10);
    expect(ceiling.axes.tokens).toBeCloseTo(0.056, 10);
  });

  it('is $0 on the blocked axis when every priced model is disallowed', () => {
    const ceiling = ceilingSpendPerDay(
      [
        { limitKey: 'model.allowed', value: false },
        { limitKey: 'chat.messagesPerDay', value: 30 },
      ],
      index,
      'typical',
    );
    expect(ceiling).toMatchObject({
      bounded: true,
      usdPerDay: 0,
      axis: 'blocked',
      priciestModelId: null,
    });
  });

  it('is unbounded when nothing priced is served (static fallback entries do not count)', () => {
    expect(
      ceilingSpendPerDay(
        [{ limitKey: 'chat.messagesPerDay', value: 30 }],
        buildPricingIndex([]),
        'typical',
      ),
    ).toEqual({ bounded: false });
  });
});

describe('spentSoFarUsd', () => {
  const index = buildPricingIndex([OpenAIModels[TERRA], OpenAIModels[LUNA]]);
  const cells: CostCell[] = [];

  it('prefers per-model request counters (the only model-aware basis)', () => {
    const spent = spentSoFarUsd(
      {
        'model:gpt-5.6-terra.requests': { used: 10 },
        'model:gpt-5.6-luna.requests': { used: 5 },
        'family:gpt-56.requests': { used: 15 },
        'chat.messagesPerDay': { used: 15 },
        'chat.tokensPerDay': { used: 22_500 },
      },
      cells,
      index,
      'typical',
    );
    expect(spent).toMatchObject({ basis: 'models', window: 'day' });
    expect(spent!.usd).toBeCloseTo(10 * 0.008 + 5 * 0.0008, 10);
    expect(spent!.unpricedCells).toEqual([]);
  });

  it('skips and reports model counters whose model has no price', () => {
    const spent = spentSoFarUsd(
      {
        'model:gpt-5.6-terra.requests': { used: 10 },
        'model:byom-abc-x.requests': { used: 99 },
      },
      cells,
      index,
      'typical',
    );
    expect(spent!.usd).toBeCloseTo(0.08, 10);
    expect(spent!.unpricedCells).toEqual(['model:byom-abc-x.requests']);
  });

  it('falls back to tokens × the highest blended rate among allowed models', () => {
    const terra = modelRequestCost(lookupPricing(index, TERRA)!, 'typical');
    const day = spentSoFarUsd(
      {
        'chat.tokensPerDay': { used: 3000 },
        'chat.messagesPerDay': { used: 2 },
      },
      cells,
      index,
      'typical',
    );
    expect(day).toMatchObject({ basis: 'tokens', window: 'day' });
    expect(day!.usd).toBeCloseTo(3000 * blendedPerTokenUsd(terra), 12);

    const month = spentSoFarUsd(
      { 'chat.tokensPerMonth': { used: 3000 } },
      cells,
      index,
      'typical',
    );
    expect(month).toMatchObject({ basis: 'tokens', window: 'month' });
  });

  it('prices tokens at the max blended rate, not the priciest-by-total model (the hint rule)', () => {
    // o3's ×3 reasoner output multiplier makes it dearest per request
    // ($0.014 over 2500 counted tokens) while gpt-5.4 has the higher $/token
    // ($0.010 over 1500). Flipped from "priciest allowed model": the token
    // hint (CostHint) uses the MAX blended rate, and the two surfaces must
    // price one counter at one rate.
    const reasoners = buildPricingIndex([
      OpenAIModels['o3'],
      OpenAIModels['gpt-5.4'],
    ]);
    const o3 = modelRequestCost(lookupPricing(reasoners, 'o3')!, 'typical');
    const gpt54 = modelRequestCost(
      lookupPricing(reasoners, 'gpt-5.4')!,
      'typical',
    );
    expect(o3.total).toBeGreaterThan(gpt54.total);
    expect(blendedPerTokenUsd(gpt54)).toBeGreaterThan(blendedPerTokenUsd(o3));

    const spent = spentSoFarUsd(
      { 'chat.tokensPerDay': { used: 1_000_000 } },
      cells,
      reasoners,
      'typical',
    );
    expect(spent!.usd).toBeCloseTo(1_000_000 * blendedPerTokenUsd(gpt54), 8);
  });

  it('falls back to messages × the priciest allowed request, honouring the allowed set', () => {
    const spent = spentSoFarUsd(
      { 'chat.messagesPerDay': { used: 4 } },
      [{ limitKey: 'model.allowed', modelId: TERRA, value: false }],
      index,
      'typical',
    );
    expect(spent).toMatchObject({ basis: 'messages', window: 'day' });
    expect(spent!.usd).toBeCloseTo(4 * 0.0008, 10);
  });

  it('is null when nothing usable was metered', () => {
    expect(spentSoFarUsd({}, cells, index, 'typical')).toBeNull();
    expect(
      spentSoFarUsd(
        { 'feature.tts.charactersPerDay': { used: 9 } },
        cells,
        index,
        'typical',
      ),
    ).toBeNull();
  });
});
