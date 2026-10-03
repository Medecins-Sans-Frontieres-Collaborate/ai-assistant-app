/**
 * Recalculating an emissions report under a chosen assumption set. Pure and
 * client-importable.
 *
 * The rollup keeps the INPUTS — tokens by size class, region, effort and
 * dedicated-reasoner flag — not the answers. The estimate is linear in
 * tokens, so summing a bucket's tokens and estimating once gives exactly
 * what estimating each request and summing would: this is a recalculation,
 * not an approximation.
 *
 * There is one formula, `estimateCO2GramsWith` in lib/utils/shared/
 * emissions.ts — the same one the app stamps onto its own usage logs.
 */
import { DatasetView } from '@/lib/services/analytics/rollupModel';

import {
  EMISSIONS_ASSUMPTIONS,
  EmissionsFactors,
  EmissionsInput,
  estimateCO2GramsWith,
} from '@/lib/utils/shared/emissions';

export interface EmissionsBucket {
  /** The breakdown label (department, model); absent for the totals. */
  group: string | null;
  sizeClass: string;
  dedicatedReasoner: boolean;
  region: string;
  effort: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  loggedWh: number;
  loggedCO2g: number;
}

const num = (value: unknown) => (typeof value === 'number' ? value : 0);

/** Reads a `recalc` / `byDepartment` / `byModel` dataset into buckets. */
export function bucketsOf(dataset: DatasetView | undefined): EmissionsBucket[] {
  if (!dataset) return [];
  const at = (name: string) => dataset.columns.indexOf(name);
  const index = {
    group: at('group'),
    sizeClass: at('sizeClass'),
    dedicatedReasoner: at('dedicatedReasoner'),
    region: at('region'),
    effort: at('effort'),
    requests: at('requests'),
    promptTokens: at('promptTokens'),
    completionTokens: at('completionTokens'),
    loggedWh: at('loggedWh'),
    loggedCO2g: at('loggedCO2g'),
  };
  return dataset.rows.map((row) => ({
    group: index.group < 0 ? null : String(row[index.group] ?? ''),
    sizeClass: String(row[index.sizeClass] ?? ''),
    dedicatedReasoner: row[index.dedicatedReasoner] === true,
    region: String(row[index.region] ?? ''),
    effort: String(row[index.effort] ?? 'none'),
    requests: num(row[index.requests]),
    promptTokens: num(row[index.promptTokens]),
    completionTokens: num(row[index.completionTokens]),
    loggedWh: num(row[index.loggedWh]),
    loggedCO2g: num(row[index.loggedCO2g]),
  }));
}

export interface EmissionsTotal {
  energyWh: number;
  gCO2e: number;
  requests: number;
  tokens: number;
  /**
   * Requests in buckets the assumption set has no factor for (a size class
   * it does not know). They are left out of the estimate, and the dashboard
   * says how many.
   */
  unpricedRequests: number;
}

const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;

function inputOf(
  bucket: EmissionsBucket,
  factors: EmissionsFactors,
): EmissionsInput | null {
  if (!(bucket.sizeClass in factors.whPer1kTokens)) return null;
  const effort = EFFORTS.find((candidate) => candidate === bucket.effort);
  return {
    promptTokens: bucket.promptTokens,
    completionTokens: bucket.completionTokens,
    sizeClass: bucket.sizeClass as EmissionsInput['sizeClass'],
    isDedicatedReasoner: bucket.dedicatedReasoner,
    reasoningEffort: effort,
    region:
      bucket.region === 'EU' || bucket.region === 'US' ? bucket.region : null,
  };
}

export function estimateBuckets(
  buckets: readonly EmissionsBucket[],
  factors: EmissionsFactors,
): EmissionsTotal {
  const total: EmissionsTotal = {
    energyWh: 0,
    gCO2e: 0,
    requests: 0,
    tokens: 0,
    unpricedRequests: 0,
  };
  for (const bucket of buckets) {
    total.requests += bucket.requests;
    total.tokens += bucket.promptTokens + bucket.completionTokens;
    const input = inputOf(bucket, factors);
    if (!input) {
      total.unpricedRequests += bucket.requests;
      continue;
    }
    const estimate = estimateCO2GramsWith(factors, input);
    total.energyWh += estimate.energyWh;
    total.gCO2e += estimate.gCO2e;
  }
  return total;
}

/** One total per breakdown label, largest CO2e first. */
export function estimateByGroup(
  buckets: readonly EmissionsBucket[],
  factors: EmissionsFactors,
): (EmissionsTotal & { group: string })[] {
  const groups = new Map<string, EmissionsBucket[]>();
  for (const bucket of buckets) {
    const key = bucket.group ?? '';
    const existing = groups.get(key);
    if (existing) existing.push(bucket);
    else groups.set(key, [bucket]);
  }
  return [...groups]
    .map(([group, members]) => ({
      group,
      ...estimateBuckets(members, factors),
    }))
    .sort((a, b) => b.gCO2e - a.gCO2e);
}

/** The app's own current assumption set, as estimator factors. */
export function currentAppFactors(): EmissionsFactors {
  return EMISSIONS_ASSUMPTIONS;
}

/** The numeric knobs of an assumption set, flattened for a what-if form. */
export const FACTOR_FIELDS = [
  ['pue'],
  ['promptTokenWeight'],
  ['dedicatedReasoningMultiplier'],
  ['whPer1kTokens', 'nano'],
  ['whPer1kTokens', 'mini'],
  ['whPer1kTokens', 'standard'],
  ['whPer1kTokens', 'large'],
  ['whPer1kTokens', 'xl'],
  ['reasoningEffortMultipliers', 'low'],
  ['reasoningEffortMultipliers', 'medium'],
  ['reasoningEffortMultipliers', 'high'],
  ['gridIntensity', 'EU'],
  ['gridIntensity', 'US'],
  ['gridIntensity', 'default'],
] as const;

export type FactorField = (typeof FACTOR_FIELDS)[number];

export function factorKey(field: FactorField): string {
  return field.join('.');
}

export function readFactor(
  factors: EmissionsFactors,
  field: FactorField,
): number {
  if (field.length === 1) return factors[field[0]];
  const table = factors[field[0]] as Record<string, number>;
  return table[field[1]];
}

/** A copy of `factors` with one knob changed. */
export function withFactor(
  factors: EmissionsFactors,
  field: FactorField,
  value: number,
): EmissionsFactors {
  if (field.length === 1) return { ...factors, [field[0]]: value };
  return {
    ...factors,
    [field[0]]: { ...factors[field[0]], [field[1]]: value },
  };
}
