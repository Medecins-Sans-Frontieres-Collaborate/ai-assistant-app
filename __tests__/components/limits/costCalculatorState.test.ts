import { counterCellName } from '@/lib/services/limits/resolver';
import type { LimitEntry } from '@/lib/services/limits/types';

import { buildPricingIndex } from '@/lib/utils/app/limitsPricing';
import { COST_ASSUMPTIONS } from '@/lib/utils/shared/costEstimator';

import { OpenAIModels } from '@/types/openai';

import {
  CalculatorState,
  DRAFT_PRINCIPAL,
  addMixRow,
  cellsByModelIdFor,
  crossCheckCells,
  deploymentApplicable,
  effectiveDeployment,
  initialCalculatorState,
  mixPresetFamily,
  parseCalculatorState,
  runCalculator,
  synthesizeCapsPolicy,
} from '@/components/Limits/costCalculatorState';

import { describe, expect, it } from 'vitest';

/**
 * The calculator's pure layer (docs/LIMITS_COST_INSIGHTS_DESIGN.md §4c):
 * text fields validate into an EstimateInput with every issue reported at
 * once; byom/local rows are dropped unless opted in (never priced); the
 * deployment selector is "n/a" only when every priced mix model is
 * Marketplace/legacy; the cross-check resolves the DRAFT's conjunctive cells
 * with the pure resolver against a synthetic principal, and the estimator's
 * worked example 10 comes out of it unchanged (cap not binding at 20/day
 * under chat.messagesPerDay=30, ceiling $730.50 a month for 100 users).
 */

const LIVE = Object.values(OpenAIModels);
const INDEX = buildPricingIndex(LIVE);
const TERRA = 'gpt-5.6-terra';
const SOL = 'gpt-5.6-sol';
const LUNA = 'gpt-5.6-luna';
const CLAUDE = 'claude-sonnet-4-6';

function state(partial: Partial<CalculatorState> = {}): CalculatorState {
  return { ...initialCalculatorState(TERRA), ...partial };
}

function entry(
  partial: Partial<LimitEntry> & { limitKey: string },
): LimitEntry {
  return { value: null, ceiling: false, ...partial };
}

/** Worked example 10's caps: terra 50/day, gpt-56 family 500/day, chat 30/day. */
const EXAMPLE_10: LimitEntry[] = [
  entry({ limitKey: 'model.requests', modelId: TERRA, value: 50 }),
  entry({ limitKey: 'model.requests', series: 'gpt-56', value: 500 }),
  entry({ limitKey: 'chat.messagesPerDay', value: 30 }),
];

describe('initialCalculatorState / presets', () => {
  it('seeds the default model at 100%, typical, global, default tool rounds', () => {
    const s = initialCalculatorState(TERRA);
    expect(s.mix).toEqual([{ modelId: TERRA, share: '100' }]);
    expect(s.profile).toBe('typical');
    expect(s.deployment).toBe('global');
    expect(s.toolRounds).toBe(String(COST_ASSUMPTIONS.defaultToolRounds));
    expect(s.includeByom).toBe(false);
  });

  it('a family preset gives equal shares over its members', () => {
    expect(mixPresetFamily([SOL, TERRA, LUNA])).toEqual([
      { modelId: SOL, share: '33.33' },
      { modelId: TERRA, share: '33.33' },
      { modelId: LUNA, share: '33.33' },
    ]);
    expect(mixPresetFamily([])).toEqual([]);
  });

  it('addMixRow dedupes case-insensitively and seeds the mean share', () => {
    const mix = [
      { modelId: TERRA, share: '60' },
      { modelId: LUNA, share: '20' },
    ];
    expect(addMixRow(mix, 'GPT-5.6-TERRA')).toEqual(mix);
    expect(addMixRow(mix, SOL)).toEqual([
      ...mix,
      { modelId: SOL, share: '40' },
    ]);
    expect(addMixRow([], SOL)).toEqual([{ modelId: SOL, share: '100' }]);
  });
});

describe('parseCalculatorState', () => {
  it('turns a valid form into an EstimateInput', () => {
    const parsed = parseCalculatorState(
      state({ users: '100', requests: '20', period: 'month' }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input).toEqual({
      users: 100,
      requestsPerUserPerPeriod: 20,
      period: 'month',
      models: [{ modelId: TERRA, share: 100 }],
      profile: 'typical',
      deployment: 'global',
      toolRounds: COST_ASSUMPTIONS.defaultToolRounds,
    });
    expect(parsed.droppedRows).toEqual([]);
  });

  it('reports every issue at once, by field', () => {
    const parsed = parseCalculatorState(
      state({
        users: '1.5',
        requests: '-1',
        toolRounds: '0',
        mix: [{ modelId: TERRA, share: 'abc' }],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([
      { field: 'users' },
      { field: 'requests' },
      { field: 'toolRounds' },
      { field: 'share', modelId: TERRA },
      { field: 'mix' },
    ]);
  });

  it('a custom profile needs non-negative tokens with a positive sum and a 0..100 cached share', () => {
    const zero = parseCalculatorState(
      state({
        profile: 'custom',
        promptTokens: '0',
        completionTokens: '0',
        cachedSharePercent: '150',
      }),
    );
    expect(zero.ok).toBe(false);
    if (zero.ok) return;
    expect(zero.issues).toEqual([
      { field: 'tokens' },
      { field: 'cachedShare' },
    ]);

    const ok = parseCalculatorState(
      state({
        profile: 'custom',
        promptTokens: '1000',
        completionTokens: '500',
        cachedSharePercent: '50',
      }),
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.input.profile).toEqual({
      promptTokens: 1000,
      completionTokens: 500,
      cachedShare: 0.5,
    });
  });

  it('drops byom/local rows unless includeByom is on, and says which', () => {
    const mix = [
      { modelId: TERRA, share: '70' },
      { modelId: 'byom-abc-gpt-5.6-terra', share: '30' },
    ];
    const dropped = parseCalculatorState(state({ mix }));
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect(dropped.input.models).toEqual([{ modelId: TERRA, share: 70 }]);
    expect(dropped.droppedRows).toEqual(['byom-abc-gpt-5.6-terra']);

    const kept = parseCalculatorState(state({ mix, includeByom: true }));
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.input.models).toEqual([
      { modelId: TERRA, share: 70 },
      { modelId: 'byom-abc-gpt-5.6-terra', share: 30 },
    ]);
    expect(kept.droppedRows).toEqual([]);
  });

  it('a mix whose only row is a dropped byom model is an issue, not an empty estimate', () => {
    const parsed = parseCalculatorState(
      state({ mix: [{ modelId: 'byom-only', share: '100' }] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues).toEqual([{ field: 'mix' }]);
  });
});

describe('deploymentApplicable', () => {
  it('is false only when every priced mix model is Marketplace/legacy', () => {
    expect(
      deploymentApplicable([{ modelId: CLAUDE, share: '100' }], INDEX),
    ).toBe(false);
    expect(
      deploymentApplicable(
        [
          { modelId: CLAUDE, share: '50' },
          { modelId: TERRA, share: '50' },
        ],
        INDEX,
      ),
    ).toBe(true);
    expect(
      deploymentApplicable([{ modelId: TERRA, share: '100' }], INDEX),
    ).toBe(true);
  });

  it('stays applicable when nothing resolves (nothing to grey for) or the index is off', () => {
    expect(
      deploymentApplicable([{ modelId: 'nope', share: '100' }], INDEX),
    ).toBe(true);
    expect(deploymentApplicable([], INDEX)).toBe(true);
    expect(
      deploymentApplicable([{ modelId: CLAUDE, share: '100' }], null),
    ).toBe(true);
  });
});

describe('effectiveDeployment', () => {
  it('falls back to Global while the selector is greyed, keeps the choice otherwise', () => {
    const claudeOnly = [{ modelId: CLAUDE, share: '100' }];
    const mixed = [
      { modelId: CLAUDE, share: '50' },
      { modelId: TERRA, share: '50' },
    ];
    expect(
      effectiveDeployment({ mix: claudeOnly, deployment: 'dataZone' }, INDEX),
    ).toBe('global');
    expect(
      effectiveDeployment({ mix: claudeOnly, deployment: 'regional' }, INDEX),
    ).toBe('global');
    expect(
      effectiveDeployment({ mix: mixed, deployment: 'dataZone' }, INDEX),
    ).toBe('dataZone');
    // Nothing to grey for → the choice stands (matches deploymentApplicable).
    expect(
      effectiveDeployment({ mix: claudeOnly, deployment: 'dataZone' }, null),
    ).toBe('dataZone');
  });
});

describe('draft-based cells', () => {
  it('the synthetic policy carries the caps as defaults and nothing else', () => {
    const policy = synthesizeCapsPolicy(EXAMPLE_10);
    expect(policy.defaults).toEqual(EXAMPLE_10);
    expect(policy.overrides).toEqual([]);
    expect(policy.delegations).toEqual([]);
    expect(DRAFT_PRINCIPAL.groupIds).toEqual([]);
  });

  it('resolves EVERY conjunctive cell for each mix model from the draft', () => {
    const cells = cellsByModelIdFor(EXAMPLE_10, [TERRA], INDEX);
    const names = cells[TERRA].map(counterCellName);
    expect(names).toEqual([
      `model:${TERRA}.allowed`,
      'family:gpt-56.allowed',
      `model:${TERRA}.requests`,
      'family:gpt-56.requests',
      'chat.messagesPerDay',
      'chat.tokensPerDay',
      'chat.tokensPerMonth',
    ]);
    const byName = Object.fromEntries(
      cells[TERRA].map((c) => [counterCellName(c), c.value]),
    );
    expect(byName[`model:${TERRA}.requests`]).toBe(50);
    expect(byName['family:gpt-56.requests']).toBe(500);
    expect(byName['chat.messagesPerDay']).toBe(30);
    expect(byName['chat.tokensPerDay']).toBeNull();
  });

  it('finds the series from the static registry when the index is off', () => {
    const cells = cellsByModelIdFor(EXAMPLE_10, [TERRA], null);
    expect(cells[TERRA].map(counterCellName)).toContain(
      'family:gpt-56.requests',
    );
  });

  it('crossCheckCells dedupes shared cells and orders unqualified → family → model', () => {
    const cells = cellsByModelIdFor(EXAMPLE_10, [TERRA, SOL], INDEX);
    const rows = crossCheckCells(cells);
    const names = rows.map((r) => r.cell);
    expect(names.filter((n) => n === 'family:gpt-56.requests')).toHaveLength(1);
    expect(names.slice(0, 3)).toEqual([
      'chat.messagesPerDay',
      'chat.tokensPerDay',
      'chat.tokensPerMonth',
    ]);
    const modelIdx = names.indexOf(`model:${TERRA}.requests`);
    const familyIdx = names.indexOf('family:gpt-56.requests');
    expect(familyIdx).toBeLessThan(modelIdx);
    expect(rows.find((r) => r.cell === 'chat.messagesPerDay')).toMatchObject({
      value: 30,
      unit: 'requests',
      window: 'day',
    });
  });
});

describe('runCalculator', () => {
  it('worked example 10: 20/day under a 30/day message cap is within caps, ceiling $730.50 a month', () => {
    const run = runCalculator(
      state({
        users: '100',
        requests: String(20 * COST_ASSUMPTIONS.periodDays.month),
        period: 'month',
      }),
      LIVE,
      EXAMPLE_10,
      INDEX,
    );
    expect('issues' in run).toBe(false);
    if ('issues' in run) return;
    expect(run.impliedRequestsPerUserPerDay).toBeCloseTo(20, 10);
    expect(run.result.capBinding).toBe(false);
    expect(run.result.bindingCells).toEqual(['chat.messagesPerDay']);
    expect(run.result.entered.totalPerPeriod.total).toBeCloseTo(487, 10);
    expect(run.result.ceiling.totalPerPeriod.total).toBeCloseTo(730.5, 10);
  });

  it('the cap binds once the entered load exceeds it', () => {
    const run = runCalculator(
      state({ users: '100', requests: '40', period: 'day' }),
      LIVE,
      EXAMPLE_10,
      INDEX,
    );
    if ('issues' in run) throw new Error('unexpected issues');
    expect(run.result.capBinding).toBe(true);
    expect(run.result.bindingCells).toEqual(['chat.messagesPerDay']);
    expect(run.result.ceiling.requestsPerUserPerPeriod).toBeCloseTo(30, 10);
    expect(run.result.ceiling.totalPerPeriod.total).toBeCloseTo(24, 10);
  });

  it('a blocked model yields a $0 ceiling named by its allowed cell', () => {
    const run = runCalculator(
      state({ users: '10', requests: '5', period: 'day' }),
      LIVE,
      [entry({ limitKey: 'model.allowed', modelId: TERRA, value: false })],
      INDEX,
    );
    if ('issues' in run) throw new Error('unexpected issues');
    expect(run.result.capBinding).toBe(true);
    expect(run.result.bindingCells).toEqual([`model:${TERRA}.allowed`]);
    expect(run.result.ceiling.requestsPerUserPerPeriod).toBe(0);
    expect(run.result.ceiling.totalPerPeriod.total).toBe(0);
  });

  it('nothing binds when the draft has no numeric cap: ceiling is the entered estimate', () => {
    const run = runCalculator(state(), LIVE, [], INDEX);
    if ('issues' in run) throw new Error('unexpected issues');
    expect(run.result.bindingCells).toEqual([]);
    expect(run.result.ceiling).toBe(run.result.entered);
  });

  it('an excluded model in the mix marks the result incomplete and is never renormalized', () => {
    const run = runCalculator(
      state({
        includeByom: true,
        mix: [
          { modelId: TERRA, share: '70' },
          { modelId: 'byom-x', share: '30' },
        ],
      }),
      LIVE,
      [],
      INDEX,
    );
    if ('issues' in run) throw new Error('unexpected issues');
    expect(run.result.entered.incomplete).toBe(true);
    expect(run.result.entered.excluded).toEqual([
      { modelId: 'byom-x', reason: 'byom' },
    ]);
    expect(run.result.entered.perModel[0].share).toBeCloseTo(0.7, 10);
  });

  it('estimates and discloses an all-Marketplace mix at Global (×1), whatever the greyed selector holds', () => {
    // The selector keeps "Data Zone" for when an Azure model rejoins, but
    // the stated assumption must match the rows (all "multiplier n/a").
    const greyed = runCalculator(
      state({
        deployment: 'dataZone',
        mix: [{ modelId: CLAUDE, share: '100' }],
      }),
      LIVE,
      [],
      INDEX,
    );
    if ('issues' in greyed) throw new Error('expected a run');
    expect(greyed.parsed.input.deployment).toBe('global');
    expect(greyed.result.entered.assumptions.deployment).toBe('global');
    expect(greyed.result.ceiling.assumptions.deployment).toBe('global');

    // Flip side: with an Azure-billed model in the mix the choice is honoured.
    const live = runCalculator(
      state({
        deployment: 'dataZone',
        mix: [
          { modelId: CLAUDE, share: '50' },
          { modelId: TERRA, share: '50' },
        ],
      }),
      LIVE,
      [],
      INDEX,
    );
    if ('issues' in live) throw new Error('expected a run');
    expect(live.parsed.input.deployment).toBe('dataZone');
    expect(live.result.entered.assumptions.deployment).toBe('dataZone');
  });

  it('hands back the form issues instead of running', () => {
    const run = runCalculator(state({ users: 'x' }), LIVE, [], INDEX);
    expect(run).toEqual({ issues: [{ field: 'users' }] });
  });
});
