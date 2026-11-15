import {
  EMISSIONS_ASSUMPTIONS,
  SMARTPHONE_CHARGE_GRAMS,
} from '@/lib/utils/shared/emissions';
import {
  BUDGET_UNITS,
  DAILY_USAGE_RETENTION_DAYS,
  DEFAULT_USAGE_BUDGETS,
  DailyTokenUsage,
  STAGE_PERCENT_MAX,
  STAGE_PERCENT_MIN,
  UsageBudget,
  budgetLimit,
  convertBudgetAmount,
  evaluateBudget,
  hasReached,
  localDayKey,
  nextPeriodStart,
  periodBuckets,
  periodStart,
  recordDailyUsage,
  sanitizeDailyTokenUsage,
  sanitizeUsageBudgets,
  setStagePercent,
  worseState,
} from '@/lib/utils/shared/usageBudgets';

import { describe, expect, it } from 'vitest';

const NETFLIX_GRAMS_PER_HOUR =
  EMISSIONS_ASSUMPTIONS.equivalences.activityGramsPerHour.netflixHd;

/** A 100 g budget with every stage on, at 80 / 100 / 125. */
const budget = (change: Partial<UsageBudget> = {}): UsageBudget => ({
  enabled: true,
  amount: 100,
  unit: 'grams',
  period: 'month',
  stages: {
    warn: { enabled: true, percent: 80 },
    ask: { enabled: true, percent: 100 },
    stop: { enabled: true, percent: 125 },
  },
  ...change,
});

const counts = { promptTokens: 100, completionTokens: 50 };

describe('budget units', () => {
  it('resolves an activity budget to grams from the emissions assumptions', () => {
    expect(budgetLimit({ amount: 5, unit: 'netflixHd' })).toBeCloseTo(
      5 * NETFLIX_GRAMS_PER_HOUR,
    );
    expect(budgetLimit({ amount: 3, unit: 'smartphoneCharge' })).toBeCloseTo(
      3 * SMARTPHONE_CHARGE_GRAMS,
    );
    expect(budgetLimit({ amount: 20, unit: 'usd' })).toBe(20);
  });

  it('offers every configured activity as an emissions unit', () => {
    for (const activity of Object.keys(
      EMISSIONS_ASSUMPTIONS.equivalences.activityGramsPerHour,
    )) {
      expect(BUDGET_UNITS.emissions).toContain(activity);
    }
    expect(BUDGET_UNITS.cost).toEqual(['usd']);
  });

  it('keeps the same carbon when the unit changes', () => {
    const inZoom = convertBudgetAmount(5, 'netflixHd', 'zoomCall');
    // Rounded to one decimal for the field, so compare within that step.
    expect(budgetLimit({ amount: inZoom, unit: 'zoomCall' })).toBeCloseTo(
      budgetLimit({ amount: 5, unit: 'netflixHd' }),
      -1,
    );
    expect(convertBudgetAmount(5, 'netflixHd', 'grams')).toBe(
      5 * NETFLIX_GRAMS_PER_HOUR,
    );
  });
});

describe('evaluateBudget', () => {
  // The fixture brackets every threshold: just under, exactly on, just over.
  it.each([
    [0, 'ok'],
    [79.9, 'ok'],
    [80, 'warn'],
    [99.9, 'warn'],
    [100, 'ask'],
    [124.9, 'ask'],
    [125, 'stop'],
    [300, 'stop'],
  ] as const)('at %s%% of the budget the state is %s', (used, state) => {
    expect(evaluateBudget(budget(), used).state).toBe(state);
  });

  it('treats usage that sums to a hair under a threshold as having met it', () => {
    // 0.1 + 0.2 !== 0.3 in floating point: eight tenths summed lands at
    // 79.99999999999999, which must still read as 80%.
    let used = 0;
    for (let i = 0; i < 8; i++) used += 10.000000000000002 - 2e-15;
    used = 0.1 * 3 * (80 / 0.3);
    expect(used).not.toBe(80);
    expect(evaluateBudget(budget(), used).state).toBe('warn');
  });

  it('skips a stage that is switched off', () => {
    const noAsk = budget({
      stages: {
        warn: { enabled: true, percent: 80 },
        ask: { enabled: false, percent: 100 },
        stop: { enabled: true, percent: 125 },
      },
    });
    expect(evaluateBudget(noAsk, 110).state).toBe('warn');
    expect(evaluateBudget(noAsk, 125).state).toBe('stop');
  });

  it('never reaches a stage when the budget is off or has no amount', () => {
    expect(evaluateBudget(budget({ enabled: false }), 500).state).toBe('ok');
    expect(evaluateBudget(budget({ amount: 0 }), 500)).toMatchObject({
      state: 'ok',
      percent: 0,
    });
  });

  it('reports the percentage of the budget used', () => {
    expect(evaluateBudget(budget(), 82).percent).toBeCloseTo(82);
    expect(
      evaluateBudget(budget({ amount: 5, unit: 'netflixHd' }), 184).percent,
    ).toBeCloseTo((184 / (5 * NETFLIX_GRAMS_PER_HOUR)) * 100);
  });
});

describe('stage ordering', () => {
  it('ranks states warn < ask < stop', () => {
    expect(worseState('warn', 'ask')).toBe('ask');
    expect(worseState('stop', 'warn')).toBe('stop');
    expect(hasReached('ask', 'warn')).toBe(true);
    expect(hasReached('warn', 'ask')).toBe(false);
    expect(hasReached('ok', 'warn')).toBe(false);
  });

  it('pushes later stages up when an earlier one is raised past them', () => {
    const stages = setStagePercent(budget().stages, 'warn', 150);
    expect(stages.warn.percent).toBe(150);
    expect(stages.ask.percent).toBe(150);
    expect(stages.stop.percent).toBe(150);
  });

  it('pulls earlier stages down when a later one is lowered past them', () => {
    const stages = setStagePercent(budget().stages, 'stop', 50);
    expect(stages.warn.percent).toBe(50);
    expect(stages.ask.percent).toBe(50);
    expect(stages.stop.percent).toBe(50);
  });

  it('leaves the neighbours alone when the order already holds', () => {
    const stages = setStagePercent(budget().stages, 'ask', 90);
    expect(stages).toMatchObject({
      warn: { percent: 80 },
      ask: { percent: 90 },
      stop: { percent: 125 },
    });
  });

  it('clamps a threshold to the allowed range', () => {
    expect(setStagePercent(budget().stages, 'stop', 9999).stop.percent).toBe(
      STAGE_PERCENT_MAX,
    );
    expect(setStagePercent(budget().stages, 'warn', -5).warn.percent).toBe(
      STAGE_PERCENT_MIN,
    );
  });
});

describe('sanitizeUsageBudgets', () => {
  it('returns the defaults, with budgets off, for anything unusable', () => {
    expect(sanitizeUsageBudgets(undefined)).toEqual(DEFAULT_USAGE_BUDGETS);
    expect(sanitizeUsageBudgets('nonsense')).toEqual(DEFAULT_USAGE_BUDGETS);
    expect(DEFAULT_USAGE_BUDGETS.emissions.enabled).toBe(false);
    expect(DEFAULT_USAGE_BUDGETS.cost.enabled).toBe(false);
    // Refusing to send is opt-in.
    expect(DEFAULT_USAGE_BUDGETS.emissions.stages.stop.enabled).toBe(false);
  });

  it('rejects a unit that belongs to the other metric', () => {
    const clean = sanitizeUsageBudgets({
      emissions: { enabled: true, amount: 5, unit: 'usd', period: 'day' },
      cost: { enabled: true, amount: 5, unit: 'netflixHd', period: 'week' },
    });
    expect(clean.emissions.unit).toBe(DEFAULT_USAGE_BUDGETS.emissions.unit);
    expect(clean.cost.unit).toBe('usd');
    expect(clean.emissions.period).toBe('day');
    expect(clean.cost.period).toBe('week');
  });

  it('straightens stored thresholds that are out of order', () => {
    const clean = sanitizeUsageBudgets({
      emissions: {
        enabled: true,
        amount: 5,
        unit: 'grams',
        period: 'month',
        stages: {
          warn: { enabled: true, percent: 200 },
          ask: { enabled: true, percent: 100 },
          stop: { enabled: true, percent: 50 },
        },
      },
    });
    const { warn, ask, stop } = clean.emissions.stages;
    expect(warn.percent).toBeLessThanOrEqual(ask.percent);
    expect(ask.percent).toBeLessThanOrEqual(stop.percent);
  });

  it('drops a negative or non-numeric amount', () => {
    const clean = sanitizeUsageBudgets({
      emissions: { enabled: true, amount: -3, unit: 'grams' },
      cost: { enabled: true, amount: 'lots', unit: 'usd' },
    });
    expect(clean.emissions.amount).toBe(0);
    expect(clean.cost.amount).toBe(DEFAULT_USAGE_BUDGETS.cost.amount);
  });
});

describe('periods', () => {
  // 2026-11-15 is a Sunday: the last day of a Monday-start week.
  const sunday = new Date(2026, 10, 15, 14, 30);

  it('starts a day at local midnight', () => {
    expect(localDayKey(periodStart('day', sunday))).toBe('2026-11-15');
    expect(localDayKey(nextPeriodStart('day', sunday))).toBe('2026-11-16');
  });

  it('starts a week on Monday', () => {
    expect(localDayKey(periodStart('week', sunday))).toBe('2026-11-09');
    expect(localDayKey(nextPeriodStart('week', sunday))).toBe('2026-11-16');
    const monday = new Date(2026, 10, 16, 0, 5);
    expect(localDayKey(periodStart('week', monday))).toBe('2026-11-16');
  });

  it('starts a month on the first, across a year boundary', () => {
    expect(localDayKey(periodStart('month', sunday))).toBe('2026-11-01');
    expect(localDayKey(nextPeriodStart('month', sunday))).toBe('2026-12-01');
    const december = new Date(2026, 11, 31, 23, 59);
    expect(localDayKey(nextPeriodStart('month', december))).toBe('2027-01-01');
  });
});

describe('daily ledger', () => {
  const now = new Date(2026, 10, 15, 9, 0);

  it('accumulates requests under the local day and bucket', () => {
    let ledger: DailyTokenUsage = {};
    ledger = recordDailyUsage(ledger, 'm|default|none', counts, now);
    ledger = recordDailyUsage(ledger, 'm|default|none', counts, now);
    expect(ledger['2026-11-15']['m|default|none']).toEqual({
      promptTokens: 200,
      completionTokens: 100,
      requests: 2,
    });
  });

  it('does not mutate the ledger it is given', () => {
    const ledger: DailyTokenUsage = {};
    recordDailyUsage(ledger, 'm|default|none', counts, now);
    expect(ledger).toEqual({});
  });

  it('prunes days older than the retention window and keeps the boundary day', () => {
    const boundary = new Date(2026, 10, 15);
    boundary.setDate(boundary.getDate() - DAILY_USAGE_RETENTION_DAYS);
    const expired = new Date(boundary);
    expired.setDate(expired.getDate() - 1);
    const day = { 'm|default|none': { ...counts, requests: 1 } };
    const ledger = recordDailyUsage(
      { [localDayKey(boundary)]: day, [localDayKey(expired)]: day },
      'm|default|none',
      counts,
      now,
    );
    expect(ledger[localDayKey(boundary)]).toBeDefined();
    expect(ledger[localDayKey(expired)]).toBeUndefined();
  });

  it('totals only the days inside the period', () => {
    const day = { 'm|default|none': { ...counts, requests: 1 } };
    const ledger: DailyTokenUsage = {
      '2026-10-31': day, // last month
      '2026-11-01': day, // first day of the month
      '2026-11-08': day, // last week (a Sunday)
      '2026-11-09': day, // Monday: first day of this week
      '2026-11-15': day, // today
    };
    const requests = (period: 'day' | 'week' | 'month') =>
      periodBuckets(ledger, period, now)['m|default|none']?.requests ?? 0;
    expect(requests('day')).toBe(1);
    expect(requests('week')).toBe(2);
    expect(requests('month')).toBe(4);
  });

  it('discards malformed persisted entries', () => {
    expect(sanitizeDailyTokenUsage(null)).toEqual({});
    expect(
      sanitizeDailyTokenUsage({
        'not-a-day': { k: { promptTokens: 1, completionTokens: 1 } },
        '2026-11-15': {
          good: { promptTokens: 1, completionTokens: 2, requests: 3 },
          bad: { promptTokens: 'x', completionTokens: 2 },
        },
      }),
    ).toEqual({
      '2026-11-15': {
        good: { promptTokens: 1, completionTokens: 2, requests: 3 },
      },
    });
  });
});
