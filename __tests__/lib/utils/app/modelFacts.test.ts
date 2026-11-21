import type { ModelAccessRule } from '@/lib/services/limits/types';
import type { UsageInsights } from '@/lib/services/limits/wire';

import { buildPricingIndex } from '@/lib/utils/app/limitsPricing';
import {
  CONCENTRATED_SPEND_SHARE,
  DAYS_PER_MONTH,
  MappedModel,
  ModelFacts,
  UNREACHED_CAP_SHARE,
  capCandidates,
  capCeiling,
  compareReplacementAccess,
  estimatedFootprintGrams,
  estimatedSpendUsd,
  isRetiringSoon,
  mapFindings,
  modelCostFacts,
  modelFootprintFacts,
  modelLifecycleFacts,
  modelUsageFacts,
  monthlyCeilingUsd,
  replayCaps,
  termsOfState,
  usageHistogram,
  usageSpread,
  withRuleCarriedOver,
} from '@/lib/utils/app/modelFacts';
import { EMISSIONS_ASSUMPTIONS } from '@/lib/utils/shared/emissions';
import {
  RETIREMENT_MOVE_DAYS,
  RETIREMENT_NOTICE_DAYS,
} from '@/lib/utils/shared/modelRetirement';

import { OpenAIModel, OpenAIModelID } from '@/types/openai';

import { describe, expect, it } from 'vitest';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-21T00:00:00.000Z');

/** A priced chat model: $2 in, $10 out per 1M tokens. */
const PRICED = {
  id: 'test-priced',
  name: 'Test priced',
  maxLength: 128000,
  tokenLimit: 16000,
  modelType: 'omni',
  pricing: { inputPer1M: 2, outputPer1M: 10 },
} as unknown as OpenAIModel;

describe('cost facts', () => {
  const index = buildPricingIndex([PRICED]);
  const { promptTokens, completionTokens } =
    EMISSIONS_ASSUMPTIONS.typicalRequest;
  const typical = (promptTokens * 2 + completionTokens * 10) / 1e6;

  it('prices one typical request at list price, and a long one higher', () => {
    const cost = modelCostFacts(index, 'TEST-PRICED');
    expect(cost).not.toBeNull();
    expect(cost?.inputPer1M).toBe(2);
    expect(cost?.outputPer1M).toBe(10);
    expect(cost?.typical).toBeCloseTo(typical, 10);
    expect(cost?.heavy).toBeGreaterThan(typical);
  });

  it('answers null, never zero, for a model with no price or with cost switched off', () => {
    expect(modelCostFacts(index, 'no-such-model')).toBeNull();
    expect(modelCostFacts(null, 'test-priced')).toBeNull();
  });

  it('turns a daily cap into the most one person can cost in a month', () => {
    expect(monthlyCeilingUsd(100, 0.01)).toBeCloseTo(DAYS_PER_MONTH, 10);
    const cost = modelCostFacts(index, 'test-priced');
    expect(capCeiling(50, cost)).toEqual({
      kind: 'capped',
      typical: 50 * typical * DAYS_PER_MONTH,
      heavy: expect.any(Number),
    });
  });

  it('keeps no cap, off and unpriced apart', () => {
    const cost = modelCostFacts(index, 'test-priced');
    expect(capCeiling(null, cost)).toEqual({ kind: 'unbounded' });
    expect(capCeiling(false, cost)).toEqual({ kind: 'off' });
    expect(capCeiling(0, cost)).toEqual({ kind: 'off' });
    // Off costs nothing whatever the price; a cap on an unpriced model is unknown.
    expect(capCeiling(false, null)).toEqual({ kind: 'off' });
    expect(capCeiling(50, null)).toBeNull();
    expect(capCeiling(null, null)).toBeNull();
  });

  it('estimates spend only when both the requests and the price are known', () => {
    const cost = modelCostFacts(index, 'test-priced');
    expect(estimatedSpendUsd(1000, cost)).toBeCloseTo(1000 * typical, 10);
    expect(estimatedSpendUsd(null, cost)).toBeNull();
    expect(estimatedSpendUsd(1000, null)).toBeNull();
    expect(estimatedSpendUsd(0, cost)).toBe(0);
  });
});

describe('footprint facts', () => {
  it('estimates from the size class, and a larger class emits more', () => {
    const nano = modelFootprintFacts({ sizeClass: 'nano', modelType: 'omni' });
    const large = modelFootprintFacts({
      sizeClass: 'large',
      modelType: 'omni',
    });
    expect(nano?.sizeClass).toBe('nano');
    expect(nano?.gramsPerRequest).toBeGreaterThan(0);
    expect(large?.gramsPerRequest).toBeGreaterThan(
      nano?.gramsPerRequest as number,
    );
    expect(estimatedFootprintGrams(10, large)).toBeCloseTo(
      10 * (large?.gramsPerRequest as number),
      10,
    );
  });

  it('says "not set" (null) for a model without a size class, rather than assuming one', () => {
    expect(modelFootprintFacts({ modelType: 'omni' })).toBeNull();
    expect(modelFootprintFacts(undefined)).toBeNull();
    expect(estimatedFootprintGrams(10, null)).toBeNull();
  });
});

describe('lifecycle facts', () => {
  const retiring = (daysFromNow: number): Partial<OpenAIModel> => ({
    id: 'test-model',
    retiresAt: new Date(NOW + daysFromNow * DAY_MS).toISOString(),
  });
  const phaseAt = (days: number) =>
    modelLifecycleFacts(retiring(days) as OpenAIModel, NOW).phase;

  it('puts a model in the right phase on both sides of each window', () => {
    expect(phaseAt(RETIREMENT_NOTICE_DAYS + 1)).toBe('later');
    expect(phaseAt(RETIREMENT_NOTICE_DAYS)).toBe('notice');
    expect(phaseAt(RETIREMENT_MOVE_DAYS + 1)).toBe('notice');
    expect(phaseAt(RETIREMENT_MOVE_DAYS)).toBe('move');
    expect(phaseAt(1)).toBe('move');
    expect(phaseAt(0)).toBe('past');
    expect(phaseAt(-3)).toBe('past');
  });

  it('counts whole days and reads the date as a calendar day', () => {
    const facts = modelLifecycleFacts(retiring(21) as OpenAIModel, NOW);
    expect(facts.daysLeft).toBe(21);
    expect(facts.retiresOn).toBe('2026-12-12');
  });

  it('prefers the date discovery reports over the static catalog value', () => {
    const facts = modelLifecycleFacts(
      {
        id: 'test-model',
        retirementDate: '2026-10-14',
        retiresAt: '2027-03-05T00:00:00Z',
      } as OpenAIModel,
      NOW,
    );
    expect(facts.retiresOn).toBe('2027-03-05');
    expect(facts.phase).toBe('later');
  });

  it('treats a forced retirement as happening now, with its pinned replacement', () => {
    const facts = modelLifecycleFacts(
      {
        id: OpenAIModelID.GPT_5_2,
        retiresAt: new Date(NOW + 200 * DAY_MS).toISOString(),
        retirementReplacement: 'something-else',
      } as OpenAIModel,
      NOW,
    );
    expect(facts.phase).toBe('forced');
    expect(facts.replacementId).toBe(OpenAIModelID.GPT_5_4);
    expect(isRetiringSoon(facts.phase)).toBe(true);
  });

  it('says nothing is leaving when there is no date, no model, or an unreadable date', () => {
    expect(modelLifecycleFacts(undefined, NOW)).toEqual({ phase: 'none' });
    expect(
      modelLifecycleFacts({ id: 'm', lifecycle: 'ga' } as OpenAIModel, NOW),
    ).toEqual({ lifecycle: 'ga', phase: 'none' });
    expect(
      modelLifecycleFacts(
        { id: 'm', retirementDate: 'soon' } as OpenAIModel,
        NOW,
      ).phase,
    ).toBe('none');
    expect(isRetiringSoon('later')).toBe(false);
    expect(isRetiringSoon('past')).toBe(false);
  });
});

function insights(extra: Partial<UsageInsights>): UsageInsights {
  return {
    status: 'ready',
    latestDay: '2026-11-20',
    days: ['2026-11-20'],
    partial: false,
    cells: {},
    models: {},
    modelDays: [],
    ...extra,
  };
}

const CAPPED_CELL = {
  limitKey: 'model.requests',
  modelId: 'gpt-5.4',
  yesterday: {
    people: 2,
    bands: { underHalf: 1, toEighty: 0, nearCap: 0, atCap: 1 },
    withoutCap: 0,
  },
  byRule: {},
  events: 9,
  eventPeople: 1,
  blocked: 4,
  peaks: [3, 100],
  peaksTruncated: false,
};

describe('usage facts', () => {
  it('uses the per-model tally when it has seen the model, with cap evidence alongside', () => {
    const facts = modelUsageFacts(
      insights({
        cells: { 'model.requests|model:gpt-5.4': CAPPED_CELL },
        models: {
          'gpt-5.4': {
            modelId: 'gpt-5.4',
            people: 4,
            peopleAreLowerBound: false,
            requests: 120,
            calls: 150,
            promptTokens: 1,
            completionTokens: 1,
            activePersonDays: 10,
            peaks: [1, 3, 9, 100],
            peaksTruncated: false,
            daily: [],
          },
        },
      }),
      'GPT-5.4',
    );
    expect(facts).toMatchObject({
      source: 'captured',
      people: 4,
      requests: 120,
      average: 12,
      peaks: [1, 3, 9, 100],
      capPeople: 1,
      capEvents: 9,
      blocked: 4,
    });
  });

  it('falls back to the cap counters, and then says the total is not known', () => {
    const facts = modelUsageFacts(
      insights({ cells: { 'model.requests|model:gpt-5.4': CAPPED_CELL } }),
      'gpt-5.4',
    );
    expect(facts).toMatchObject({
      source: 'capped',
      people: 2,
      requests: null,
      average: null,
      peaks: [3, 100],
    });
  });

  it('reports no usage for an unseen model and before insights load', () => {
    expect(modelUsageFacts(insights({}), 'gpt-5.4').source).toBe('none');
    expect(modelUsageFacts(undefined, 'gpt-5.4')).toMatchObject({
      source: 'none',
      people: 0,
      requests: null,
    });
  });

  it('describes the spread and draws only the buckets someone is in', () => {
    expect(usageSpread([])).toBeNull();
    expect(usageSpread([1, 2, 3, 4, 5, 6, 7, 9, 31, 100])).toEqual({
      median: 5,
      p75: 9,
      p95: 100,
      max: 100,
    });
    expect(usageHistogram([1, 1, 2, 5, 6])).toEqual([
      { from: 1, to: 1, people: 2 },
      { from: 2, to: 2, people: 1 },
      { from: 3, to: 3, people: 0 },
      { from: 4, to: 5, people: 1 },
      { from: 6, to: 7, people: 1 },
    ]);
    const open = usageHistogram([5000]);
    expect(open.at(-1)).toEqual({ from: 1001, to: null, people: 1 });
  });

  it('replays caps: someone exactly at a cap is stopped, one below is not', () => {
    const peaks = [4, 9, 29, 30, 31, 100];
    expect(replayCaps([30, 31, 101], peaks)).toEqual([
      { cap: 30, stopped: 3, share: 0.5 },
      { cap: 31, stopped: 2, share: 2 / 6 },
      { cap: 101, stopped: 0, share: 0 },
    ]);
    expect(replayCaps([10], [])).toEqual([{ cap: 10, stopped: 0, share: 0 }]);
  });

  it('offers round caps between the median and the heaviest person, with the current cap', () => {
    const peaks = [1, 2, 4, 4, 9, 31, 100];
    const candidates = capCandidates(100, peaks);
    expect(candidates).toContain(100);
    expect(candidates).toEqual([...candidates].sort((a, b) => a - b));
    expect(candidates.length).toBeLessThanOrEqual(4);
    for (const cap of candidates) {
      expect(cap).toBeGreaterThanOrEqual(4);
      expect(cap).toBeLessThanOrEqual(100);
    }
    // No cap in force: alternatives only. Nobody to describe: just the cap.
    expect(capCandidates(null, peaks)).not.toContain(null);
    expect(capCandidates(40, [])).toEqual([40]);
    expect(capCandidates(null, [])).toEqual([]);
  });
});

function rule(partial: Partial<ModelAccessRule>): ModelAccessRule {
  return { groups: [], domains: [], allow: [], deny: [], ...partial };
}
const FROM = { modelId: 'old-model', series: undefined };
const TO = { modelId: 'new-model', series: undefined };

describe('replacement access', () => {
  it('reads access states as terms', () => {
    expect(termsOfState({ kind: 'unlimited' })).toBeNull();
    expect(termsOfState({ kind: 'unavailable' })).toBe(false);
    expect(termsOfState({ kind: 'limited', requests: 20 })).toBe(20);
  });

  it('calls two models with the same rules the same', () => {
    expect(compareReplacementAccess([], [], FROM, TO)).toEqual({
      kind: 'same',
    });
    const grant = { target: 'oca.msf.org', requests: 10 };
    expect(
      compareReplacementAccess(
        [
          rule({ modelId: 'old-model', defaultAccess: 30, domains: [grant] }),
          rule({ modelId: 'new-model', defaultAccess: 30, domains: [grant] }),
        ],
        [],
        FROM,
        TO,
      ),
    ).toEqual({ kind: 'same' });
  });

  it('separates a different answer for everyone from different named audiences', () => {
    const rules = [
      rule({
        modelId: 'old-model',
        defaultAccess: 30,
        domains: [{ target: 'oca.msf.org', requests: 10 }],
        deny: ['ana@msf.org'],
      }),
      rule({
        modelId: 'new-model',
        domains: [{ target: 'oca.msf.org', requests: 99 }],
      }),
    ];
    expect(compareReplacementAccess(rules, [], FROM, TO)).toEqual({
      kind: 'differs',
      everyone: true,
      audiences: 2,
    });
    expect(
      compareReplacementAccess(
        [rule({ modelId: 'old-model', defaultAccess: false })],
        [],
        FROM,
        TO,
      ),
    ).toEqual({ kind: 'differs', everyone: true, audiences: 0 });
  });

  it('compares "everyone else" as it resolves through the family', () => {
    // The family caps both models at 20, so a model rule saying 20 changes nothing.
    const rules = [
      rule({ series: 'fam', defaultAccess: 20 }),
      rule({ modelId: 'old-model', defaultAccess: 20 }),
    ];
    expect(
      compareReplacementAccess(
        rules,
        [],
        { modelId: 'old-model', series: 'fam' },
        { modelId: 'new-model', series: 'fam' },
      ),
    ).toEqual({ kind: 'same' });
  });

  it('carries the rule over, replacing what the replacement had, and then they match', () => {
    const source = rule({
      modelId: 'old-model',
      defaultAccess: 30,
      domains: [{ target: 'oca.msf.org', requests: 10 }],
      deny: ['ana@msf.org'],
    });
    const rules = [
      source,
      rule({ modelId: 'new-model', allow: [{ target: 'x@msf.org' }] }),
    ];
    const next = withRuleCarriedOver(rules, [], FROM, TO);
    expect(next).toEqual([source, { ...source, modelId: 'new-model' }]);
    expect(compareReplacementAccess(next, [], FROM, TO)).toEqual({
      kind: 'same',
    });
    // The input is not mutated.
    expect(rules[1].allow).toHaveLength(1);
  });

  it('writes out an inherited answer, so it means the same in another family', () => {
    const rules = [rule({ series: 'fam', defaultAccess: 20 })];
    const next = withRuleCarriedOver(
      rules,
      [],
      { modelId: 'old-model', series: 'fam' },
      TO,
    );
    expect(next).toEqual([
      rules[0],
      rule({ modelId: 'new-model', defaultAccess: 20 }),
    ]);
  });
});

/** A used model for the map: `peaks` ascending, spend in USD. */
function mapped(
  label: string,
  terms: number | null | false,
  peaks: number[],
  extra: { spendUsd?: number | null; capPeople?: number } = {},
): MappedModel {
  return {
    label,
    terms,
    facts: {
      modelId: label,
      model: undefined,
      cost: null,
      footprint: null,
      lifecycle: { phase: 'none' },
      usage: {
        source: 'captured',
        people: peaks.length,
        requests: peaks.reduce((sum, value) => sum + value, 0),
        average: null,
        peaks,
        peaksTruncated: false,
        capPeople: extra.capPeople ?? 0,
        capEvents: 0,
        blocked: 0,
      },
      spendUsd: extra.spendUsd ?? null,
      footprintGrams: null,
    } satisfies ModelFacts,
  };
}

describe('map findings', () => {
  it('calls spend concentrated at the threshold, and not just under it', () => {
    const at = mapFindings([
      mapped('A', false, [1], { spendUsd: CONCENTRATED_SPEND_SHARE * 100 }),
      mapped('B', false, [1], { spendUsd: 30 }),
      mapped('C', false, [1], { spendUsd: 30 }),
    ]);
    expect(at).toContainEqual({
      kind: 'concentrated',
      label: 'A',
      share: CONCENTRATED_SPEND_SHARE,
    });
    const under = mapFindings([
      mapped('A', false, [1], { spendUsd: 39 }),
      mapped('B', false, [1], { spendUsd: 31 }),
      mapped('C', false, [1], { spendUsd: 30 }),
    ]);
    expect(under.some((f) => f.kind === 'concentrated')).toBe(false);
    // One model is always all of the spend: that is not a finding.
    expect(mapFindings([mapped('A', false, [1], { spendUsd: 5 })])).toEqual([]);
  });

  it('flags a cap nobody comes near, but not one somebody got halfway to', () => {
    const half = 100 * UNREACHED_CAP_SHARE;
    expect(mapFindings([mapped('Far', 100, [3, half - 1])])).toEqual([
      { kind: 'unreached', label: 'Far', cap: 100, max: half - 1 },
    ]);
    expect(mapFindings([mapped('Half', 100, [3, half])])).toEqual([]);
  });

  it('reports caps people reached and models with no ceiling', () => {
    const findings = mapFindings([
      mapped('Capped', 30, [4, 30, 31], { capPeople: 2 }),
      mapped('Open', null, [2, 300]),
      mapped('Off', false, [5]),
      mapped('Unused', null, []),
    ]);
    expect(findings).toEqual([
      { kind: 'reached', label: 'Capped', cap: 30, people: 2, of: 3 },
      { kind: 'noCeiling', labels: ['Open'], max: 300 },
    ]);
  });

  it('finds nothing with nothing used', () => {
    expect(mapFindings([])).toEqual([]);
    expect(mapFindings([mapped('Unused', 10, [])])).toEqual([]);
  });
});
