/**
 * Personal usage budgets: limits a user sets for THEMSELVES on estimated
 * emissions and estimated cost (Settings › Usage & Impact).
 *
 * Pure + shared: types, defaults, unit conversion, period arithmetic and the
 * stage evaluation. No React, no store, no feature flags.
 *
 * ── Conventions (stated once; every caller cites these) ───────────────────
 *  - Base units: an emissions budget is evaluated in GRAMS of CO2e, a cost
 *    budget in US DOLLARS. A budget is STORED as (amount, unit) — "5 hours of
 *    Netflix HD" — and resolved to its base unit at evaluation time, so an
 *    edit to config/emissions.json re-prices the budget like every other
 *    figure here.
 *  - Stages escalate warn → ask → stop, and their thresholds are kept in that
 *    order ({@link setStagePercent}). A threshold is a percentage OF THE
 *    BUDGET, so 100 is the budget itself and 125 is a quarter past it.
 *  - A stage is reached at `used >= threshold`, with a tolerance
 *    ({@link THRESHOLD_EPSILON}): usage is a sum of floats and would otherwise
 *    sit a hair under a threshold it has in fact met.
 *  - Periods are in the user's LOCAL time and weeks start on Monday.
 *  - Day keys are local `YYYY-MM-DD`, which sort lexicographically in date
 *    order — the ledger relies on that.
 *
 * These are self-imposed limits enforced in the browser from the locally
 * accumulated usage; the limits an administrator sets are a separate,
 * server-enforced system (lib/services/limits).
 */
import {
  ActivityKey,
  EMISSIONS_ASSUMPTIONS,
  SMARTPHONE_CHARGE_GRAMS,
} from '@/lib/utils/shared/emissions';
import { TokenCounts } from '@/lib/utils/shared/usageImpact';

export const BUDGET_METRICS = ['emissions', 'cost'] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** In escalation order: a heads-up, a confirmation, a refusal. */
export const BUDGET_STAGES = ['warn', 'ask', 'stop'] as const;
export type BudgetStage = (typeof BUDGET_STAGES)[number];

/** Where usage stands against a budget; `ok` is "no stage reached". */
export type BudgetState = 'ok' | BudgetStage;

const ACTIVITY_KEYS = Object.keys(
  EMISSIONS_ASSUMPTIONS.equivalences.activityGramsPerHour,
) as ActivityKey[];

export type EmissionsBudgetUnit = 'grams' | ActivityKey | 'smartphoneCharge';
export type CostBudgetUnit = 'usd';
export type BudgetUnit = EmissionsBudgetUnit | CostBudgetUnit;

/** The units each metric's budget can be expressed in, in display order. */
export const BUDGET_UNITS: Readonly<
  Record<BudgetMetric, readonly BudgetUnit[]>
> = {
  emissions: ['grams', ...ACTIVITY_KEYS, 'smartphoneCharge'],
  cost: ['usd'],
};

/**
 * The unit each metric is EVALUATED in (see the conventions above). Readouts
 * that report usage against a budget use this, whatever unit the budget was
 * set in: the activity units are a way of choosing a limit, not of measuring.
 */
export const BUDGET_BASE_UNIT: Readonly<Record<BudgetMetric, BudgetUnit>> = {
  emissions: 'grams',
  cost: 'usd',
};

export interface BudgetStageRule {
  enabled: boolean;
  /** Percentage of the budget at which the stage is reached. */
  percent: number;
}

export interface UsageBudget {
  enabled: boolean;
  /** Magnitude in `unit` (hours for an activity unit). */
  amount: number;
  unit: BudgetUnit;
  period: BudgetPeriod;
  stages: Record<BudgetStage, BudgetStageRule>;
}

export type UsageBudgets = Record<BudgetMetric, UsageBudget>;

export const STAGE_PERCENT_MIN = 1;
export const STAGE_PERCENT_MAX = 500;

const DEFAULT_STAGES: Record<BudgetStage, BudgetStageRule> = {
  warn: { enabled: true, percent: 80 },
  ask: { enabled: true, percent: 100 },
  // Refusing to send is opt-in: nobody should meet it by switching a budget on.
  stop: { enabled: false, percent: 125 },
};

/** Budgets are off until the user turns one on. */
export const DEFAULT_USAGE_BUDGETS: UsageBudgets = {
  emissions: {
    enabled: false,
    amount: 5,
    unit: 'netflixHd',
    period: 'month',
    stages: DEFAULT_STAGES,
  },
  cost: {
    enabled: false,
    amount: 20,
    unit: 'usd',
    period: 'month',
    stages: DEFAULT_STAGES,
  },
};

/** True for the units measured in hours of an activity. */
export function isActivityUnit(unit: BudgetUnit): unit is ActivityKey {
  return (ACTIVITY_KEYS as string[]).includes(unit);
}

/** Base units (grams, or dollars) in ONE of `unit`. */
export function baseUnitsPer(unit: BudgetUnit): number {
  if (unit === 'grams' || unit === 'usd') return 1;
  if (unit === 'smartphoneCharge') return SMARTPHONE_CHARGE_GRAMS;
  return EMISSIONS_ASSUMPTIONS.equivalences.activityGramsPerHour[unit];
}

/** The budget in its base unit: grams of CO2e, or dollars. */
export function budgetLimit(
  budget: Pick<UsageBudget, 'amount' | 'unit'>,
): number {
  return budget.amount * baseUnitsPer(budget.unit);
}

/** Expresses a base-unit quantity in `unit`. */
export function fromBaseUnits(base: number, unit: BudgetUnit): number {
  return base / baseUnitsPer(unit);
}

/**
 * Re-expresses a budget amount in another unit, keeping the underlying
 * quantity the same (5 h of Netflix HD → 4.5 h on a Zoom call). Rounded to
 * one decimal so the field never shows float noise.
 */
export function convertBudgetAmount(
  amount: number,
  from: BudgetUnit,
  to: BudgetUnit,
): number {
  const converted = fromBaseUnits(amount * baseUnitsPer(from), to);
  return Math.round(converted * 10) / 10;
}

const clampPercent = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(
    STAGE_PERCENT_MAX,
    Math.max(STAGE_PERCENT_MIN, Math.round(parsed)),
  );
};

/**
 * Sets one stage's threshold and keeps the escalation order: earlier stages
 * are pulled down to it and later ones pushed up, so "stop before warn" is
 * not a state the form can reach.
 */
export function setStagePercent(
  stages: Record<BudgetStage, BudgetStageRule>,
  stage: BudgetStage,
  percent: number,
): Record<BudgetStage, BudgetStageRule> {
  const target = clampPercent(percent, stages[stage].percent);
  const index = BUDGET_STAGES.indexOf(stage);
  const next = { ...stages };
  BUDGET_STAGES.forEach((id, i) => {
    const current = stages[id].percent;
    const ordered =
      i === index
        ? target
        : i < index
          ? Math.min(current, target)
          : Math.max(current, target);
    next[id] = { ...stages[id], percent: ordered };
  });
  return next;
}

function sanitizeBudget(metric: BudgetMetric, value: unknown): UsageBudget {
  const fallback = DEFAULT_USAGE_BUDGETS[metric];
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Partial<UsageBudget>;
  const amount =
    typeof raw.amount === 'number' && Number.isFinite(raw.amount)
      ? Math.max(0, raw.amount)
      : fallback.amount;
  const rawStages = (raw.stages ?? {}) as Partial<
    Record<BudgetStage, Partial<BudgetStageRule>>
  >;
  let stages = { ...fallback.stages };
  for (const stage of BUDGET_STAGES) {
    stages[stage] = {
      enabled:
        typeof rawStages[stage]?.enabled === 'boolean'
          ? (rawStages[stage]?.enabled as boolean)
          : fallback.stages[stage].enabled,
      percent: fallback.stages[stage].percent,
    };
  }
  // Applied in order so a stored out-of-order set is straightened, not kept.
  for (const stage of BUDGET_STAGES) {
    stages = setStagePercent(
      stages,
      stage,
      clampPercent(rawStages[stage]?.percent, fallback.stages[stage].percent),
    );
  }
  return {
    enabled: raw.enabled === true,
    amount,
    unit: BUDGET_UNITS[metric].includes(raw.unit as BudgetUnit)
      ? (raw.unit as BudgetUnit)
      : fallback.unit,
    period: BUDGET_PERIODS.includes(raw.period as BudgetPeriod)
      ? (raw.period as BudgetPeriod)
      : fallback.period,
    stages,
  };
}

/**
 * Normalizes persisted budgets. Applied on rehydrate and on every write: the
 * value round-trips through localStorage, and a hand edit must not be able to
 * produce a budget that blocks sending by accident.
 */
export function sanitizeUsageBudgets(value: unknown): UsageBudgets {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<
    Record<BudgetMetric, unknown>
  >;
  return {
    emissions: sanitizeBudget('emissions', raw.emissions),
    cost: sanitizeBudget('cost', raw.cost),
  };
}

// ── Periods ────────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local `YYYY-MM-DD` for a date. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight at the start of the period containing `now`. */
export function periodStart(period: BudgetPeriod, now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'week') {
    // getDay(): Sunday = 0. Days since Monday, per the module convention.
    const sinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - sinceMonday);
  } else if (period === 'month') {
    start.setDate(1);
  }
  return start;
}

/** Local midnight at which the period containing `now` ends and usage resets. */
export function nextPeriodStart(period: BudgetPeriod, now: Date): Date {
  const start = periodStart(period, now);
  if (period === 'day') start.setDate(start.getDate() + 1);
  else if (period === 'week') start.setDate(start.getDate() + 7);
  else start.setMonth(start.getMonth() + 1);
  return start;
}

// ── Daily ledger ───────────────────────────────────────────────────────────

/** Raw usage per local day, each day keyed like `tokenUsageStats`. */
export type DailyTokenUsage = Record<string, Record<string, TokenCounts>>;

/**
 * Days of ledger kept. The longest period is a month (≤ 31 days); the rest is
 * slack so a clock or timezone change cannot cut into the current period.
 */
export const DAILY_USAGE_RETENTION_DAYS = 62;

/**
 * Adds one request to the ledger under `now`'s local day and drops days older
 * than the retention window. Returns a new ledger; the input is not mutated.
 */
export function recordDailyUsage(
  ledger: DailyTokenUsage,
  bucketKey: string,
  counts: Pick<TokenCounts, 'promptTokens' | 'completionTokens'>,
  now: Date,
): DailyTokenUsage {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  cutoff.setDate(cutoff.getDate() - DAILY_USAGE_RETENTION_DAYS);
  const cutoffKey = localDayKey(cutoff);
  const dayKey = localDayKey(now);

  const next: DailyTokenUsage = {};
  for (const [key, day] of Object.entries(ledger)) {
    if (key >= cutoffKey) next[key] = day;
  }
  const day = next[dayKey] ?? {};
  const bucket = day[bucketKey];
  next[dayKey] = {
    ...day,
    [bucketKey]: {
      promptTokens: (bucket?.promptTokens ?? 0) + counts.promptTokens,
      completionTokens:
        (bucket?.completionTokens ?? 0) + counts.completionTokens,
      requests: (bucket?.requests ?? 0) + 1,
    },
  };
  return next;
}

/** Merges the ledger's days from the start of the period into one bucket set. */
export function periodBuckets(
  ledger: DailyTokenUsage,
  period: BudgetPeriod,
  now: Date,
): Record<string, TokenCounts> {
  const startKey = localDayKey(periodStart(period, now));
  const merged: Record<string, TokenCounts> = {};
  for (const [dayKey, day] of Object.entries(ledger)) {
    if (dayKey < startKey) continue;
    for (const [bucketKey, counts] of Object.entries(day)) {
      const existing = merged[bucketKey];
      merged[bucketKey] = {
        promptTokens: (existing?.promptTokens ?? 0) + counts.promptTokens,
        completionTokens:
          (existing?.completionTokens ?? 0) + counts.completionTokens,
        requests: (existing?.requests ?? 0) + counts.requests,
      };
    }
  }
  return merged;
}

/** Drops anything that is not a day → bucket → counts shape. */
export function sanitizeDailyTokenUsage(value: unknown): DailyTokenUsage {
  if (!value || typeof value !== 'object') return {};
  const clean: DailyTokenUsage = {};
  for (const [dayKey, day] of Object.entries(value as object)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
    if (!day || typeof day !== 'object') continue;
    const buckets: Record<string, TokenCounts> = {};
    for (const [bucketKey, counts] of Object.entries(day as object)) {
      const c = counts as Partial<TokenCounts> | null;
      if (
        !c ||
        !Number.isFinite(c.promptTokens) ||
        !Number.isFinite(c.completionTokens)
      ) {
        continue;
      }
      buckets[bucketKey] = {
        promptTokens: c.promptTokens as number,
        completionTokens: c.completionTokens as number,
        requests: Number.isFinite(c.requests) ? (c.requests as number) : 0,
      };
    }
    clean[dayKey] = buckets;
  }
  return clean;
}

// ── Evaluation ─────────────────────────────────────────────────────────────

/** Tolerance, in percentage points, on every threshold comparison. */
export const THRESHOLD_EPSILON = 1e-6;

const STATE_RANK: Record<BudgetState, number> = {
  ok: 0,
  warn: 1,
  ask: 2,
  stop: 3,
};

/** The more severe of two states. */
export function worseState(a: BudgetState, b: BudgetState): BudgetState {
  return STATE_RANK[b] > STATE_RANK[a] ? b : a;
}

/** True when `state` is at least as severe as `stage`. */
export function hasReached(state: BudgetState, stage: BudgetStage): boolean {
  return STATE_RANK[state] >= STATE_RANK[stage];
}

export interface BudgetEvaluation {
  /** The budget in its base unit (grams or dollars). */
  limit: number;
  /** Usage this period, in the same base unit. */
  used: number;
  /** `used / limit` as a percentage; 0 when there is no usable limit. */
  percent: number;
  state: BudgetState;
}

/**
 * Where `used` stands against a budget.
 *
 * A disabled budget, or one with no positive amount, never reaches a stage:
 * "0 of 0" must not read as a breach.
 *
 * @param budget - The budget and its stage rules.
 * @param used - Usage this period, in the budget's base unit.
 */
export function evaluateBudget(
  budget: UsageBudget,
  used: number,
): BudgetEvaluation {
  const limit = budgetLimit(budget);
  if (!budget.enabled || !(limit > 0)) {
    return { limit, used, percent: 0, state: 'ok' };
  }
  const percent = (used / limit) * 100;
  let state: BudgetState = 'ok';
  for (const stage of BUDGET_STAGES) {
    const rule = budget.stages[stage];
    if (rule.enabled && percent >= rule.percent - THRESHOLD_EPSILON) {
      state = stage;
    }
  }
  return { limit, used, percent, state };
}
