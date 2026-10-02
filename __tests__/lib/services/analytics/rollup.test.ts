import {
  bucketsOf,
  estimateBuckets,
  estimateByGroup,
  readFactor,
  withFactor,
} from '@/lib/services/analytics/emissionsCalc';
import {
  SMALL_GROUPS_LABEL,
  SMALL_GROUP_THRESHOLD,
} from '@/lib/services/analytics/rollup';
import {
  buildRollup,
  parseDeliveredAssumptions,
} from '@/lib/services/analytics/rollupBuild';
import { viewDataset, viewRollup } from '@/lib/services/analytics/rollupModel';
import { DerivedTable, gridToTable } from '@/lib/services/analytics/tables';

import {
  EMISSIONS_ASSUMPTIONS,
  estimateCO2GramsWith,
} from '@/lib/utils/shared/emissions';

import { Row } from './workbooks';

import { describe, expect, it } from 'vitest';

function sheet(name: string, grid: Row[], freeform = false): DerivedTable {
  return gridToTable({
    name,
    grid,
    sourceRows: grid.length,
    freeform,
    declaredFields: [],
    maxRows: Number.POSITIVE_INFINITY,
  });
}

/** `count` people in one department, each with `each` interactions. */
function people(
  department: string,
  count: number,
  each: number,
  from: number,
): Row[] {
  return Array.from({ length: count }, (_, i) => [
    `u-${String(from + i).padStart(6, '0')}`,
    department,
    `Title ${from + i}`,
    'HQ',
    each,
  ]);
}

const USAGE: DerivedTable[] = [
  sheet('Summary', [
    [
      'slice',
      'unique_users',
      'interactions',
      'avg_interactions_per_user',
      'share_users_vs_all_msf_pct',
    ],
    ['OCBA', 13, 190, 14.6, 6.7],
    ['All MSF', 3292, 273609, 83.11, 100],
  ]),
  sheet('Users', [
    [
      'UserId',
      'UserDepartment',
      'UserJobTitle',
      'WorkLocation',
      'total_interactions',
    ],
    ...people('Logistics', 6, 20, 0),
    ...people('Medical', 5, 10, 100),
    ...people('Advocacy', 2, 10, 200),
  ]),
  sheet('Daily', [
    [
      'date',
      'unique_users',
      'interactions',
      'hq_users',
      'field_users',
      'unknown_location_users',
    ],
    ['2026-07-01', 9, 120, 8, 1, 0],
    ['2026-07-02', 7, 70, 6, 1, 0],
  ]),
  sheet('Interactions', [
    ['UserId', 'ModelUsed', 'MessageCount'],
    ['u-000000', 'gpt-5.4', 3],
    ['u-000001', 'gpt-5.4', 5],
    ['u-000000', 'gpt-5.2', 1],
    ['u-000002', '', 0],
  ]),
];

describe('usage rollup', () => {
  const rollup = buildRollup('usage', '1:v', USAGE);

  it('takes the headline figures from the report’s own summary, with its comparator', () => {
    expect(rollup.kpis).toMatchObject({
      users: 13,
      interactions: 190,
      avgPerUser: 14.6,
      shareUsers: 6.7,
      all_users: 3292,
      all_avgPerUser: 83.11,
    });
    expect(rollup.text).toEqual({ slice: 'OCBA', comparator: 'All MSF' });
  });

  it('groups people by department, counting distinct people, largest first', () => {
    expect(rollup.datasets.byDepartment).toEqual({
      columns: ['group', 'users', 'interactions'],
      rows: [
        ['Logistics', 6, 120],
        ['Medical', 5, 50],
        ['Advocacy', 2, 20],
      ],
      field: 'department',
      people: { Logistics: 6, Medical: 5, Advocacy: 2 },
    });
  });

  it('gates the location split on the work-location field, though it arrives as column names', () => {
    expect(rollup.datasets.dailyByLocation.field).toBe('workLocation');
    expect(rollup.datasets.daily.field).toBeNull();
    expect(rollup.datasets.daily.rows[0]).toEqual(['2026-07-01', 9, 120]);
  });

  it('counts model usage per model, leaving out events that used none', () => {
    expect(rollup.datasets.byModel.rows).toEqual([
      ['gpt-5.4', 2, 2, 8],
      ['gpt-5.2', 1, 1, 1],
    ]);
  });

  it('bands people by how much they used it', () => {
    expect(rollup.datasets.activity.rows).toEqual([
      ['1–10', 7],
      ['11–50', 6],
      ['51–100', 0],
      ['101–250', 0],
      ['251–500', 0],
      ['501+', 0],
    ]);
    // A count of people in a band names no attribute: nothing to fold.
    expect(rollup.datasets.activity.people).toBeNull();
  });

  it('simply omits a dataset whose sheet is missing', () => {
    const partial = buildRollup(
      'usage',
      '1:v',
      USAGE.filter((table) => table.name !== 'Interactions'),
    );
    expect(partial.datasets.byModel).toBeUndefined();
    expect(partial.datasets.byDepartment).toBeDefined();
  });
});

describe('rebilling rollup', () => {
  const rollup = buildRollup('rebilling', '1:v', [
    sheet('Allocation', [
      ['AI Assistant rebilling — 2026-07'],
      [],
      ['Section', 'Usage events', 'Usage %', 'Billed', 'Currency'],
      ['Germany', 100, 10, 825.62, 'USD'],
      ['OC Amsterdam', 900, 90, 4209.76, 'USD'],
      ['Total', 1000, null, 5035.38, null],
    ]),
    sheet('Reconciliation', [
      ['Reconciliation to Azure'],
      [],
      ['Line', 'Amount', 'Currency'],
      ['Azure cost, resource group total', 5035.38, 'USD'],
      ['    of which usage-variable', 4700, 'USD'],
      ['    of which static infrastructure', 335.38, 'USD'],
    ]),
    sheet('Changes', [
      ['Section', 'Previous file', 'Restated', 'Change'],
      ['Germany', 0, 825.62, 825.62],
      ['OC Amsterdam', 4209.76, 4209.76, 0],
    ]),
    sheet('Attribution', [
      ['Section', 'Mail domain', 'Usage events', 'Users'],
      ['Germany', 'berlin.msf.org', 100, 255],
      ['OC Amsterdam', 'oca.msf.org', 880, 899],
      ['OC Amsterdam', 'tiny.example.org', 20, 2],
    ]),
  ]);

  it('totals the sections, not the Total row, without float drift', () => {
    expect(rollup.kpis).toMatchObject({
      sections: 2,
      totalBilled: 5035.38,
      usageEvents: 1000,
      resourceGroupTotal: 5035.38,
      usageVariable: 4700,
      staticInfrastructure: 335.38,
    });
    expect(rollup.text.currency).toBe('USD');
  });

  it('ranks sections by what they were billed', () => {
    expect(rollup.datasets.bySection.rows.map((row) => row[0])).toEqual([
      'OC Amsterdam',
      'Germany',
    ]);
    // Billing by section describes no people.
    expect(rollup.datasets.bySection.people).toBeNull();
  });

  it('treats a mail domain’s user count as people, so tiny domains can be folded', () => {
    expect(rollup.datasets.byDomain.people).toEqual({
      'berlin.msf.org': 255,
      'oca.msf.org': 899,
      'tiny.example.org': 2,
    });
  });
});

const ASSUMPTIONS_PAGE: Row[] = [
  ['AI Platform emissions report'],
  [],
  ['Scalar assumptions'],
  ['Assumptions version', '2026-09.1', 'Every estimate is traceable'],
  ['PUE (data-center overhead)', 1.15],
  ['Prompt token weight', 0.15],
  ['Dedicated-reasoner multiplier', 1.1],
  ['Smartphone charge (g CO2e)', 13.5],
  ['Size class', 'Wh per 1k tokens'],
  ['nano', 0.03],
  ['mini', 0.1],
  ['standard', 0.4],
  ['large', 1.2],
  ['xl', 2.4],
  ['Effort', 'Multiplier'],
  ['none', 1],
  ['minimal', 1],
  ['low', 1.05],
  ['medium', 1.1],
  ['high', 1.2],
  ['Region', 'g CO2e / kWh'],
  ['US', 370],
  ['EU', 230],
  ['default', 370],
];

/** The assumption set written on ASSUMPTIONS_PAGE, as estimator factors. */
const PAGE_FACTORS = {
  assumptionsVersion: '2026-09.1',
  pue: 1.15,
  promptTokenWeight: 0.15,
  dedicatedReasoningMultiplier: 1.1,
  whPer1kTokens: { nano: 0.03, mini: 0.1, standard: 0.4, large: 1.2, xl: 2.4 },
  reasoningEffortMultipliers: {
    none: 1,
    minimal: 1,
    low: 1.05,
    medium: 1.1,
    high: 1.2,
  },
  gridIntensity: { US: 370, EU: 230, default: 370 },
};

/**
 * One line of `Usage detail`. The two "app-logged" columns are what the app
 * would have recorded at the time under PAGE_FACTORS — computed, not typed
 * in, so the fixture cannot disagree with the formula it is testing against.
 */
function detailRow(
  user: string,
  department: string,
  model: string,
  sizeClass: 'standard' | 'large',
  reasoner: boolean,
  region: 'EU' | 'default',
  effort: 'medium' | 'high' | null,
  requests: number,
  prompt: number,
  completion: number,
): Row {
  const logged = estimateCO2GramsWith(PAGE_FACTORS, {
    promptTokens: prompt,
    completionTokens: completion,
    sizeClass,
    isDedicatedReasoner: reasoner,
    reasoningEffort: effort ?? undefined,
    region: region === 'EU' ? 'EU' : null,
  });
  return [
    user,
    department,
    model,
    sizeClass,
    reasoner,
    region,
    effort,
    requests,
    prompt,
    completion,
    logged.energyWh,
    logged.gCO2e,
  ];
}

const DETAIL: Row[] = [
  [
    'User code',
    'Department',
    'Model',
    'Size class',
    'Dedicated reasoner',
    'Region',
    'Reasoning effort',
    'Requests',
    'Prompt tokens',
    'Completion tokens',
    'App-logged energy Wh',
    'App-logged CO2e g',
  ],
  detailRow(
    'u-000001',
    'Fundraising',
    'gpt-5.4',
    'large',
    false,
    'EU',
    'medium',
    10,
    100000,
    20000,
  ),
  detailRow(
    'u-000002',
    'Fundraising',
    'gpt-5.4',
    'large',
    false,
    'EU',
    'medium',
    5,
    50000,
    5000,
  ),
  detailRow(
    'u-000002',
    'Finance',
    'gpt-5.2',
    'standard',
    false,
    'EU',
    null,
    4,
    20000,
    10000,
  ),
  detailRow(
    'u-000003',
    'Finance',
    'o-reasoner',
    'standard',
    true,
    'default',
    'high',
    1,
    1000,
    1000,
  ),
];

describe('emissions rollup', () => {
  const rollup = buildRollup('emissions', '1:v', [
    sheet('Assumptions', ASSUMPTIONS_PAGE, true),
    sheet('Usage detail', DETAIL),
  ]);

  it('reads the report’s own assumption set off its Assumptions page', () => {
    expect(rollup.assumptions).toEqual({
      assumptionsVersion: '2026-09.1',
      pue: 1.15,
      promptTokenWeight: 0.15,
      dedicatedReasoningMultiplier: 1.1,
      whPer1kTokens: {
        nano: 0.03,
        mini: 0.1,
        standard: 0.4,
        large: 1.2,
        xl: 2.4,
      },
      reasoningEffortMultipliers: {
        none: 1,
        minimal: 1,
        low: 1.05,
        medium: 1.1,
        high: 1.2,
      },
      gridIntensity: { US: 370, EU: 230, default: 370 },
      smartphoneChargeGrams: 13.5,
    });
  });

  it('gives no assumptions rather than a partial set', () => {
    const incomplete = ASSUMPTIONS_PAGE.filter((row) => row[0] !== 'large');
    expect(
      parseDeliveredAssumptions(sheet('Assumptions', incomplete, true)),
    ).toBeNull();
    expect(parseDeliveredAssumptions(undefined)).toBeNull();
  });

  it('keeps the INPUTS, bucketed by what the estimate depends on', () => {
    expect(rollup.datasets.recalc.columns).toEqual([
      'sizeClass',
      'dedicatedReasoner',
      'region',
      'effort',
      'requests',
      'promptTokens',
      'completionTokens',
      'loggedWh',
      'loggedCO2g',
    ]);
    // Rows 1 and 2 share every factor and collapse into one bucket.
    expect(rollup.datasets.recalc.rows).toHaveLength(3);
    expect(rollup.datasets.recalc.rows[0].slice(0, 7)).toEqual([
      'large',
      false,
      'EU',
      'medium',
      15,
      150000,
      25000,
    ]);
    expect(rollup.kpis).toMatchObject({
      requests: 20,
      promptTokens: 171000,
      completionTokens: 36000,
      activeUsers: 3,
    });
  });

  it('counts distinct people per department across its buckets', () => {
    expect(rollup.datasets.byDepartment.people).toEqual({
      Fundraising: 2,
      Finance: 2,
    });
  });

  describe('recalculation', () => {
    const buckets = bucketsOf({
      columns: rollup.datasets.recalc.columns,
      rows: rollup.datasets.recalc.rows,
      folded: false,
    });

    it('from buckets equals estimating every row and summing — it is exact', () => {
      const perRow = DETAIL.slice(1).reduce((sum, row) => {
        const estimate = estimateCO2GramsWith(EMISSIONS_ASSUMPTIONS, {
          promptTokens: row[8] as number,
          completionTokens: row[9] as number,
          sizeClass: row[3] as 'large',
          isDedicatedReasoner: row[4] as boolean,
          reasoningEffort: (row[6] ?? undefined) as 'medium' | undefined,
          region: row[5] === 'EU' ? 'EU' : null,
        });
        return sum + estimate.gCO2e;
      }, 0);
      expect(estimateBuckets(buckets, EMISSIONS_ASSUMPTIONS).gCO2e).toBeCloseTo(
        perRow,
        9,
      );
    });

    it('under the report’s own assumptions reproduces what the app logged', () => {
      const total = estimateBuckets(buckets, rollup.assumptions!);
      expect(total.energyWh).toBeCloseTo(rollup.kpis.loggedWh!, 3);
      expect(total.gCO2e).toBeCloseTo(rollup.kpis.loggedCO2g!, 3);
    });

    it('moves when an assumption does', () => {
      const base = estimateBuckets(buckets, rollup.assumptions!);
      const doubled = withFactor(rollup.assumptions!, ['pue'], 2.3);
      expect(readFactor(doubled, ['pue'])).toBe(2.3);
      // Energy is linear in PUE.
      expect(estimateBuckets(buckets, doubled).energyWh).toBeCloseTo(
        base.energyWh * 2,
        9,
      );
      const cleanerGrid = withFactor(
        rollup.assumptions!,
        ['gridIntensity', 'EU'],
        0,
      );
      expect(estimateBuckets(buckets, cleanerGrid).gCO2e).toBeLessThan(
        base.gCO2e,
      );
      // The original is untouched.
      expect(rollup.assumptions!.pue).toBe(1.15);
    });

    it('leaves out, and counts, usage of a model size the set has no figure for', () => {
      const total = estimateBuckets(
        [{ ...buckets[0], sizeClass: 'colossal', requests: 7 }, buckets[1]],
        EMISSIONS_ASSUMPTIONS,
      );
      expect(total.unpricedRequests).toBe(7);
      expect(total.requests).toBe(7 + buckets[1].requests);
    });

    it('totals per breakdown label', () => {
      const groups = estimateByGroup(
        bucketsOf({
          columns: rollup.datasets.byDepartment.columns,
          rows: rollup.datasets.byDepartment.rows,
          folded: false,
        }),
        EMISSIONS_ASSUMPTIONS,
      );
      expect(groups.map((group) => group.group)).toEqual([
        'Fundraising',
        'Finance',
      ]);
      const sum = groups.reduce((total, group) => total + group.gCO2e, 0);
      expect(sum).toBeCloseTo(
        estimateBuckets(buckets, EMISSIONS_ASSUMPTIONS).gCO2e,
        9,
      );
    });
  });
});

describe('raw telemetry rollup', () => {
  const rollup = buildRollup('raw-telemetry', '1:v', [
    gridToTable({
      name: 'data',
      header: [
        'TimeGenerated',
        'EventType',
        'UserId',
        'UserCompanyName',
        'ErrorCode',
        'Model',
        'TotalTokens',
        'EstimatedEnergyWh',
        'EstimatedCO2Grams',
      ],
      grid: [
        [
          '2026-09-26T00:00:30.147Z',
          'ChatCompletion',
          'a',
          'OCA',
          '',
          '',
          null,
          null,
          null,
        ],
        [
          '2026-09-26T00:10:00.000Z',
          'TokenUsage',
          'a',
          'OCA',
          '',
          'gpt-5.4',
          1000,
          1.2,
          0.3,
        ],
        [
          '2026-09-26T09:15:00.000Z',
          'TokenUsage',
          'b',
          'OCG',
          '',
          'gpt-5.4',
          500,
          0.6,
          0.1,
        ],
        [
          '2026-09-26T09:20:00.000Z',
          'Error',
          'b',
          'OCG',
          'CHAT_EXECUTION_FAILED',
          '',
          null,
          null,
          null,
        ],
      ],
      sourceRows: 4,
      freeform: false,
      declaredFields: [],
      maxRows: Number.POSITIVE_INFINITY,
    }),
  ]);

  it('summarises the day without carrying anyone’s identity', () => {
    expect(rollup.kpis).toEqual({
      tokens: 1500,
      energyWh: expect.closeTo(1.8, 9),
      co2g: expect.closeTo(0.4, 9),
      events: 4,
      users: 2,
      errors: 1,
    });
    expect(rollup.datasets.byEventType.rows[0]).toEqual(['TokenUsage', 2, 2]);
    expect(rollup.datasets.byErrorCode.rows).toEqual([
      ['CHAT_EXECUTION_FAILED', 1, 1],
    ]);
    expect(rollup.datasets.hourly.rows[0]).toEqual(['00:00', 2]);
    expect(rollup.datasets.hourly.rows[9]).toEqual(['09:00', 2]);
    expect(JSON.stringify(rollup)).not.toMatch(/"a"|"b"/);
  });
});

describe('viewRollup — what a person sees of a rollup', () => {
  const rollup = buildRollup('usage', '1:v', USAGE);
  const none = new Set<never>();

  it('folds groups of fewer than five people into one row at view level, keeping the total', () => {
    const view = viewRollup(rollup, { access: 'view', hidden: none });
    expect(view.datasets.byDepartment).toEqual({
      columns: ['group', 'users', 'interactions'],
      rows: [
        ['Logistics', 6, 120],
        ['Medical', 5, 50],
        [SMALL_GROUPS_LABEL, 2, 20],
      ],
      folded: true,
    });
    expect(SMALL_GROUP_THRESHOLD).toBe(5);
  });

  it('merges several small groups into that one row', () => {
    const view = viewRollup(rollup, { access: 'view', hidden: none });
    // Every job title here belongs to one person.
    expect(view.datasets.byJobTitle.rows).toEqual([
      [SMALL_GROUPS_LABEL, 13, 190],
    ]);
  });

  it('does not fold for someone who can open the per-person rows anyway', () => {
    for (const access of ['download', 'admin'] as const) {
      const view = viewRollup(rollup, { access, hidden: none });
      expect(view.datasets.byDepartment.rows).toHaveLength(3);
      expect(view.datasets.byDepartment.folded).toBe(false);
    }
  });

  it('never folds a dataset that describes no people', () => {
    const view = viewRollup(rollup, { access: 'view', hidden: none });
    expect(view.datasets.activity.folded).toBe(false);
    expect(view.datasets.daily.rows).toHaveLength(2);
  });

  it('withholds a breakdown whose field is hidden, and says which', () => {
    const view = viewRollup(rollup, {
      access: 'download',
      hidden: new Set(['jobTitle', 'workLocation'] as const),
    });
    expect(view.datasets.byJobTitle).toBeUndefined();
    expect(view.withheld.sort()).toEqual([
      'byJobTitle',
      'byLocation',
      'dailyByLocation',
    ]);
    // The headline figures and the unrelated breakdowns are untouched.
    expect(view.kpis.users).toBe(13);
    expect(view.datasets.byDepartment).toBeDefined();
  });

  it('shows admins everything regardless of the policy', () => {
    const view = viewRollup(rollup, {
      access: 'admin',
      hidden: new Set(['jobTitle'] as const),
    });
    expect(view.withheld).toEqual([]);
    expect(view.datasets.byJobTitle.rows).toHaveLength(13);
  });

  it('can be narrowed to the datasets a trend needs', () => {
    const view = viewRollup(rollup, { access: 'admin', hidden: none }, [
      'daily',
    ]);
    expect(Object.keys(view.datasets)).toEqual(['daily']);
    expect(view.kpis.users).toBe(13);
  });

  it('folds by the people behind a label, not by the rows it has', () => {
    // One department spread over three buckets: 6 people → not folded.
    const view = viewDataset(
      {
        columns: ['group', 'sizeClass', 'requests'],
        rows: [
          ['Big', 'large', 1],
          ['Big', 'standard', 2],
          ['Tiny', 'large', 4],
          ['Small', 'large', 8],
        ],
        field: 'department',
        people: { Big: 6, Tiny: 1, Small: 4 },
      },
      { access: 'view', hidden: none },
    );
    expect(view?.rows).toEqual([
      ['Big', 'large', 1],
      ['Big', 'standard', 2],
      [SMALL_GROUPS_LABEL, 'large', 12],
    ]);
  });
});
