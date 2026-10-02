/**
 * Builds a file's rollup from its tables. Pure: tables in, rollup out.
 *
 * One builder per report type. Each reads the sheets and columns its report
 * type REQUIRES (reportTypes.ts), by normalized name; a dataset whose source
 * is missing is simply absent, and the dashboard panel that needs it says so.
 * The validator has already reported the missing piece to the admin.
 */
import { normalizeColumnName } from '@/lib/services/analytics/fields';
import {
  DeliveredAssumptions,
  FileRollup,
  ROLLUP_VERSION,
  RollupDataset,
} from '@/lib/services/analytics/rollup';
import { Cell, DerivedTable } from '@/lib/services/analytics/tables';
import { AnalyticsReportTypeId } from '@/lib/services/analytics/types';

/** Sheets a builder needs read IN FULL (not capped) to be correct. */
export const ROLLUP_FULL_SHEETS: Record<
  AnalyticsReportTypeId,
  readonly string[]
> = {
  usage: ['Users', 'Interactions'],
  rebilling: [],
  emissions: ['Usage detail'],
  'raw-telemetry': [],
};

/** A table read by column NAME, tolerant of case and spacing. */
class Sheet {
  private readonly index = new Map<string, number>();

  constructor(readonly table: DerivedTable) {
    table.columns.forEach((column, i) => {
      const key = normalizeColumnName(column.name);
      if (!this.index.has(key)) this.index.set(key, i);
    });
  }

  has(...names: string[]): boolean {
    return names.every((name) => this.index.has(normalizeColumnName(name)));
  }

  get rows(): Cell[][] {
    return this.table.rows;
  }

  cell(row: Cell[], name: string): Cell {
    const i = this.index.get(normalizeColumnName(name));
    return i === undefined ? null : (row[i] ?? null);
  }

  num(row: Cell[], name: string): number {
    return toNumber(this.cell(row, name)) ?? 0;
  }

  /** Null when the cell is blank or not a number. */
  maybeNum(row: Cell[], name: string): number | null {
    return toNumber(this.cell(row, name));
  }

  text(row: Cell[], name: string): string {
    const value = this.cell(row, name);
    return value === null ? '' : String(value).trim();
  }
}

function toNumber(value: Cell): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/%$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sheetOf(tables: readonly DerivedTable[], name: string): Sheet | null {
  const table = tables.find(
    (candidate) => candidate.name === name && candidate.layout === 'table',
  );
  return table ? new Sheet(table) : null;
}

/** Sums of decimals drift in the last bits (10957.009999999993): trim it. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** A blank grouping value still needs a label the reader can see. */
const UNSPECIFIED = '(not specified)';
const label = (value: string) => (value === '' ? UNSPECIFIED : value);

interface Group {
  people: Set<string>;
  sums: number[];
}

/**
 * Groups rows by a label, summing `measures` and counting distinct people.
 * Rows come back largest-first on the first measure.
 */
function groupBy(
  sheet: Sheet,
  labelColumn: string,
  personColumn: string | null,
  measures: readonly ((row: Cell[]) => number)[],
): { rows: Cell[][]; people: Record<string, number> } {
  const groups = new Map<string, Group>();
  for (const row of sheet.rows) {
    const key = label(sheet.text(row, labelColumn));
    let group = groups.get(key);
    if (!group) {
      group = { people: new Set(), sums: measures.map(() => 0) };
      groups.set(key, group);
    }
    if (personColumn) {
      const person = sheet.text(row, personColumn);
      if (person !== '') group.people.add(person);
    }
    measures.forEach((measure, i) => {
      group.sums[i] += measure(row);
    });
  }
  const sorted = [...groups].sort(
    ([aKey, a], [bKey, b]) =>
      (b.sums[0] ?? 0) - (a.sums[0] ?? 0) || aKey.localeCompare(bKey),
  );
  return {
    rows: sorted.map(([key, group]) => [
      key,
      group.people.size,
      ...group.sums.map(round),
    ]),
    people: Object.fromEntries(
      sorted.map(([key, group]) => [key, group.people.size]),
    ),
  };
}

// ── Usage ─────────────────────────────────────────────────────────────────

/** Upper bounds of the activity bands; the last band is open-ended. */
const ACTIVITY_BANDS: readonly [label: string, upTo: number][] = [
  ['1–10', 10],
  ['11–50', 50],
  ['51–100', 100],
  ['101–250', 250],
  ['251–500', 500],
  ['501+', Number.POSITIVE_INFINITY],
];

function passThrough(
  sheet: Sheet,
  columns: readonly string[],
): Cell[][] | null {
  if (!sheet.has(...columns)) return null;
  return sheet.rows.map((row) =>
    columns.map((column, i) =>
      i === 0 ? sheet.text(row, column) : sheet.maybeNum(row, column),
    ),
  );
}

function buildUsage(
  tables: readonly DerivedTable[],
): Omit<FileRollup, 'version' | 'blobVersion' | 'reportType'> {
  const kpis: FileRollup['kpis'] = {};
  const text: FileRollup['text'] = {};
  const datasets: FileRollup['datasets'] = {};

  const summary = sheetOf(tables, 'Summary');
  if (summary?.has('slice')) {
    // Two rows: the slice this report is about, and the all-MSF comparator.
    const all = summary.rows.find((row) =>
      /^all\b/i.test(summary.text(row, 'slice')),
    );
    const own = summary.rows.find((row) => row !== all);
    const figures: [kpi: string, column: string][] = [
      ['users', 'unique_users'],
      ['interactions', 'interactions'],
      ['avgPerUser', 'avg_interactions_per_user'],
      ['medianPerUser', 'median_interactions_per_user'],
      ['hqPct', 'hq_user_pct'],
      ['fieldPct', 'field_user_pct'],
      ['shareUsers', 'share_users_vs_all_msf_pct'],
      ['shareUsage', 'share_usage_vs_all_msf_pct'],
    ];
    if (own) {
      text.slice = summary.text(own, 'slice');
      for (const [kpi, column] of figures) {
        kpis[kpi] = summary.maybeNum(own, column);
      }
    }
    if (all) {
      text.comparator = summary.text(all, 'slice');
      for (const [kpi, column] of figures.slice(0, 6)) {
        kpis[`all_${kpi}`] = summary.maybeNum(all, column);
      }
    }
  }

  for (const [name, dateColumn] of [
    ['daily', 'date'],
    ['weekly', 'week_start'],
  ] as const) {
    const sheet = sheetOf(tables, name === 'daily' ? 'Daily' : 'Weekly');
    if (!sheet) continue;
    const activity = passThrough(sheet, [
      dateColumn,
      'unique_users',
      'interactions',
    ]);
    if (activity) {
      datasets[name] = {
        columns: ['date', 'users', 'interactions'],
        rows: activity,
        field: null,
        people: null,
      };
    }
    const location = passThrough(sheet, [
      dateColumn,
      'hq_users',
      'field_users',
      'unknown_location_users',
    ]);
    if (location) {
      datasets[`${name}ByLocation`] = {
        columns: ['date', 'hq', 'field', 'unknown'],
        rows: location,
        // The split IS work location, though it arrives as column names.
        field: 'workLocation',
        people: null,
      };
    }
  }

  const users = sheetOf(tables, 'Users');
  if (users?.has('UserId', 'total_interactions')) {
    const interactions = (row: Cell[]) => users.num(row, 'total_interactions');
    const breakdowns: [
      name: string,
      column: string,
      field: RollupDataset['field'],
    ][] = [
      ['byDepartment', 'UserDepartment', 'department'],
      ['byJobTitle', 'UserJobTitle', 'jobTitle'],
      ['byLocation', 'WorkLocation', 'workLocation'],
    ];
    for (const [name, column, field] of breakdowns) {
      if (!users.has(column)) continue;
      const grouped = groupBy(users, column, 'UserId', [interactions]);
      datasets[name] = {
        columns: ['group', 'users', 'interactions'],
        rows: grouped.rows,
        field,
        people: grouped.people,
      };
    }
    const bands = ACTIVITY_BANDS.map(() => 0);
    for (const row of users.rows) {
      const total = interactions(row);
      if (total <= 0) continue;
      bands[ACTIVITY_BANDS.findIndex(([, upTo]) => total <= upTo)] += 1;
    }
    datasets.activity = {
      columns: ['band', 'users'],
      rows: ACTIVITY_BANDS.map(([band], i) => [band, bands[i]]),
      field: null,
      // A count of people in an activity band names no attribute of theirs:
      // there is no group to fold.
      people: null,
    };
  }

  const interactions = sheetOf(tables, 'Interactions');
  if (interactions?.has('UserId', 'ModelUsed')) {
    // Events with no model (file uploads, exports) are not model usage.
    const withModel = new Sheet({
      ...interactions.table,
      rows: interactions.rows.filter(
        (row) => interactions.text(row, 'ModelUsed') !== '',
      ),
    });
    const grouped = groupBy(withModel, 'ModelUsed', 'UserId', [
      () => 1,
      (row) => interactions.num(row, 'MessageCount'),
    ]);
    datasets.byModel = {
      columns: ['group', 'users', 'events', 'messages'],
      rows: grouped.rows,
      field: 'technical',
      people: grouped.people,
    };
  }

  return { kpis, text, datasets };
}

// ── Rebilling ─────────────────────────────────────────────────────────────

function buildRebilling(
  tables: readonly DerivedTable[],
): Omit<FileRollup, 'version' | 'blobVersion' | 'reportType'> {
  const kpis: FileRollup['kpis'] = {};
  const text: FileRollup['text'] = {};
  const datasets: FileRollup['datasets'] = {};
  const isTotal = (value: string) => /^total$/i.test(value);

  const allocation = sheetOf(tables, 'Allocation');
  if (allocation?.has('Section', 'Billed')) {
    const rows = allocation.rows.filter(
      (row) => !isTotal(allocation.text(row, 'Section')),
    );
    datasets.bySection = {
      columns: [
        'section',
        'usageEvents',
        'usagePct',
        'infrastructure',
        'usage',
        'billed',
      ],
      rows: rows
        .map((row): Cell[] => [
          label(allocation.text(row, 'Section')),
          allocation.maybeNum(row, 'Usage events'),
          allocation.maybeNum(row, 'Usage %'),
          allocation.maybeNum(row, 'Infrastructure'),
          allocation.maybeNum(row, 'Usage'),
          allocation.num(row, 'Billed'),
        ])
        .sort((a, b) => (b[5] as number) - (a[5] as number)),
      field: 'section',
      people: null,
    };
    kpis.sections = rows.length;
    kpis.totalBilled = round(
      rows.reduce((sum, row) => sum + allocation.num(row, 'Billed'), 0),
    );
    kpis.usageEvents = allocation.has('Usage events')
      ? rows.reduce((sum, row) => sum + allocation.num(row, 'Usage events'), 0)
      : null;
    const currency = rows
      .map((row) => allocation.text(row, 'Currency'))
      .find((value) => value !== '');
    if (currency) text.currency = currency;
  }

  const reconciliation = sheetOf(tables, 'Reconciliation');
  if (reconciliation?.has('Line', 'Amount')) {
    datasets.reconciliation = {
      columns: ['line', 'amount'],
      rows: reconciliation.rows.map((row) => [
        reconciliation.text(row, 'Line'),
        reconciliation.maybeNum(row, 'Amount'),
      ]),
      field: 'technical',
      people: null,
    };
    const amountOf = (pattern: RegExp) => {
      const row = reconciliation.rows.find((candidate) =>
        pattern.test(reconciliation.text(candidate, 'Line')),
      );
      return row ? reconciliation.maybeNum(row, 'Amount') : null;
    };
    kpis.resourceGroupTotal = amountOf(/resource group total/i);
    kpis.usageVariable = amountOf(/usage-variable/i);
    kpis.staticInfrastructure = amountOf(/static infrastructure/i);
  }

  const changes = sheetOf(tables, 'Changes');
  if (changes?.has('Section', 'Previous file', 'Restated', 'Change')) {
    datasets.changes = {
      columns: ['section', 'previous', 'restated', 'change'],
      rows: changes.rows
        .filter((row) => !isTotal(changes.text(row, 'Section')))
        .map((row) => [
          label(changes.text(row, 'Section')),
          changes.maybeNum(row, 'Previous file'),
          changes.maybeNum(row, 'Restated'),
          changes.num(row, 'Change'),
        ]),
      field: 'section',
      people: null,
    };
  }

  const attribution = sheetOf(tables, 'Attribution');
  if (attribution?.has('Mail domain', 'Usage events', 'Users')) {
    const people: Record<string, number> = {};
    const rows = attribution.rows.map((row): Cell[] => {
      const domain = label(attribution.text(row, 'Mail domain'));
      people[domain] = (people[domain] ?? 0) + attribution.num(row, 'Users');
      return [
        domain,
        attribution.num(row, 'Users'),
        attribution.num(row, 'Usage events'),
        attribution.text(row, 'Section'),
      ];
    });
    datasets.byDomain = {
      columns: ['group', 'users', 'usageEvents', 'section'],
      rows,
      field: 'mailDomain',
      people,
    };
  }

  return { kpis, text, datasets };
}

// ── Emissions ─────────────────────────────────────────────────────────────

const SIZE_CLASSES = ['nano', 'mini', 'standard', 'large', 'xl'] as const;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
const REGIONS = ['US', 'EU', 'default'] as const;

/**
 * Reads the assumption set off the laid-out `Assumptions` page: every value
 * sits in column B beside its label in column A. Returns null unless EVERY
 * factor the estimate needs was found — a partial set would recalculate to
 * confident nonsense.
 */
export function parseDeliveredAssumptions(
  table: DerivedTable | undefined,
): DeliveredAssumptions | null {
  if (!table) return null;
  const byLabel = new Map<string, Cell>();
  for (const row of table.rows) {
    const key = typeof row[0] === 'string' ? row[0].trim().toLowerCase() : '';
    if (key !== '' && !byLabel.has(key)) byLabel.set(key, row[1] ?? null);
  }
  const numberAt = (key: string) => toNumber(byLabel.get(key) ?? null);
  const startingWith = (prefix: string) => {
    for (const [key, value] of byLabel) {
      if (key.startsWith(prefix)) return toNumber(value);
    }
    return null;
  };

  const version = byLabel.get('assumptions version');
  const pue = startingWith('pue');
  const promptTokenWeight = numberAt('prompt token weight');
  const dedicated = startingWith('dedicated-reasoner multiplier');
  const table5 = <K extends string>(keys: readonly K[]) => {
    const out = {} as Record<K, number>;
    for (const key of keys) {
      const value = numberAt(key.toLowerCase());
      if (value === null) return null;
      out[key] = value;
    }
    return out;
  };
  const whPer1kTokens = table5(SIZE_CLASSES);
  const reasoningEffortMultipliers = table5(EFFORTS);
  const gridIntensity = table5(REGIONS);

  if (
    typeof version !== 'string' ||
    pue === null ||
    promptTokenWeight === null ||
    dedicated === null ||
    !whPer1kTokens ||
    !reasoningEffortMultipliers ||
    !gridIntensity
  ) {
    return null;
  }
  return {
    assumptionsVersion: version.trim(),
    pue,
    promptTokenWeight,
    dedicatedReasoningMultiplier: dedicated,
    whPer1kTokens,
    reasoningEffortMultipliers,
    gridIntensity,
    smartphoneChargeGrams: startingWith('smartphone charge'),
  };
}

function isTrue(value: Cell): boolean {
  return (
    value === true ||
    (typeof value === 'string' && /^(true|yes)$/i.test(value.trim()))
  );
}

function buildEmissions(
  tables: readonly DerivedTable[],
): Omit<FileRollup, 'version' | 'blobVersion' | 'reportType'> {
  const kpis: FileRollup['kpis'] = {};
  const datasets: FileRollup['datasets'] = {};
  const assumptions = parseDeliveredAssumptions(
    tables.find((table) => table.name === 'Assumptions'),
  );

  const detail = sheetOf(tables, 'Usage detail');
  if (
    detail?.has(
      'Size class',
      'Region',
      'Requests',
      'Prompt tokens',
      'Completion tokens',
    )
  ) {
    // What the estimate depends on. Rows sharing these four are additive.
    const factorsOf = (row: Cell[]): Cell[] => [
      detail.text(row, 'Size class').toLowerCase(),
      isTrue(detail.cell(row, 'Dedicated reasoner')),
      detail.text(row, 'Region'),
      detail.text(row, 'Reasoning effort').toLowerCase() || 'none',
    ];
    const measuresOf = (row: Cell[]): number[] => [
      detail.num(row, 'Requests'),
      detail.num(row, 'Prompt tokens'),
      detail.num(row, 'Completion tokens'),
      detail.num(row, 'App-logged energy Wh'),
      detail.num(row, 'App-logged CO2e g'),
    ];
    const FACTORS = ['sizeClass', 'dedicatedReasoner', 'region', 'effort'];
    const MEASURES = [
      'requests',
      'promptTokens',
      'completionTokens',
      'loggedWh',
      'loggedCO2g',
    ];

    const bucket = (groupColumn: string | null) => {
      const buckets = new Map<string, { head: Cell[]; sums: number[] }>();
      const people = new Map<string, Set<string>>();
      for (const row of detail.rows) {
        const group = groupColumn ? label(detail.text(row, groupColumn)) : null;
        const head = [...(group === null ? [] : [group]), ...factorsOf(row)];
        const key = JSON.stringify(head);
        let entry = buckets.get(key);
        if (!entry) {
          entry = { head, sums: MEASURES.map(() => 0) };
          buckets.set(key, entry);
        }
        measuresOf(row).forEach((value, i) => {
          entry.sums[i] += value;
        });
        if (group !== null) {
          const person = detail.text(row, 'User code');
          if (!people.has(group)) people.set(group, new Set());
          if (person !== '') people.get(group)!.add(person);
        }
      }
      return {
        rows: [...buckets.values()].map(({ head, sums }) => [
          ...head,
          ...sums.map(round),
        ]),
        people: Object.fromEntries(
          [...people].map(([group, set]) => [group, set.size]),
        ),
      };
    };

    const recalc = bucket(null);
    datasets.recalc = {
      columns: [...FACTORS, ...MEASURES],
      rows: recalc.rows,
      field: null,
      people: null,
    };
    for (const [name, column, field] of [
      ['byDepartment', 'Department', 'department'],
      ['byModel', 'Model', 'technical'],
    ] as const) {
      if (!detail.has(column)) continue;
      const grouped = bucket(column);
      datasets[name] = {
        columns: ['group', ...FACTORS, ...MEASURES],
        rows: grouped.rows,
        field,
        people: grouped.people,
      };
    }

    const sum = (i: number) =>
      round(detail.rows.reduce((total, row) => total + measuresOf(row)[i], 0));
    kpis.requests = sum(0);
    kpis.promptTokens = sum(1);
    kpis.completionTokens = sum(2);
    kpis.loggedWh = sum(3);
    kpis.loggedCO2g = sum(4);
    kpis.activeUsers = detail.has('User code')
      ? new Set(
          detail.rows
            .map((row) => detail.text(row, 'User code'))
            .filter((code) => code !== ''),
        ).size
      : null;
  }

  return { kpis, text: {}, datasets, assumptions };
}

// ── Raw telemetry ─────────────────────────────────────────────────────────

function buildTelemetry(
  tables: readonly DerivedTable[],
): Omit<FileRollup, 'version' | 'blobVersion' | 'reportType'> {
  const kpis: FileRollup['kpis'] = {};
  const datasets: FileRollup['datasets'] = {};
  const data = sheetOf(tables, 'data');
  if (!data?.has('EventType')) return { kpis, text: {}, datasets };

  const events = () => 1;
  const person = data.has('UserId') ? 'UserId' : null;
  const simple = (column: string, rows: Cell[][] = data.rows) => {
    const sheet = new Sheet({ ...data.table, rows });
    const grouped = groupBy(sheet, column, person, [events]);
    return grouped.rows.map((row) => [row[0], row[2], row[1]]);
  };

  datasets.byEventType = {
    columns: ['group', 'events', 'users'],
    rows: simple('EventType'),
    field: null,
    people: null,
  };
  if (data.has('UserCompanyName')) {
    datasets.byCompany = {
      columns: ['group', 'events', 'users'],
      rows: simple('UserCompanyName'),
      field: null,
      people: null,
    };
  }
  if (data.has('ErrorCode')) {
    datasets.byErrorCode = {
      columns: ['group', 'events', 'users'],
      rows: simple(
        'ErrorCode',
        data.rows.filter((row) => data.text(row, 'ErrorCode') !== ''),
      ),
      field: null,
      people: null,
    };
  }
  if (data.has('TimeGenerated')) {
    const hours = Array.from({ length: 24 }, () => 0);
    for (const row of data.rows) {
      const stamp = data.text(row, 'TimeGenerated');
      // A midnight timestamp arrives as a bare date: hour 0.
      const hour = stamp.length > 10 ? new Date(stamp).getUTCHours() : 0;
      if (Number.isInteger(hour)) hours[hour] += 1;
    }
    datasets.hourly = {
      columns: ['hour', 'events'],
      rows: hours.map((count, hour) => [
        `${String(hour).padStart(2, '0')}:00`,
        count,
      ]),
      field: null,
      people: null,
    };
  }
  if (data.has('Model', 'TotalTokens')) {
    const tokenRows = data.rows.filter(
      (row) => data.text(row, 'EventType') === 'TokenUsage',
    );
    const sheet = new Sheet({ ...data.table, rows: tokenRows });
    const grouped = groupBy(sheet, 'Model', person, [
      (row) => sheet.num(row, 'TotalTokens'),
      events,
      (row) => sheet.num(row, 'EstimatedEnergyWh'),
      (row) => sheet.num(row, 'EstimatedCO2Grams'),
    ]);
    datasets.byModel = {
      columns: ['group', 'users', 'tokens', 'requests', 'energyWh', 'co2g'],
      rows: grouped.rows,
      field: null,
      people: null,
    };
    kpis.tokens = tokenRows.reduce(
      (sum, row) => sum + sheet.num(row, 'TotalTokens'),
      0,
    );
    kpis.energyWh = tokenRows.reduce(
      (sum, row) => sum + sheet.num(row, 'EstimatedEnergyWh'),
      0,
    );
    kpis.co2g = tokenRows.reduce(
      (sum, row) => sum + sheet.num(row, 'EstimatedCO2Grams'),
      0,
    );
  }

  kpis.events = data.rows.length;
  kpis.users = person
    ? new Set(data.rows.map((row) => data.text(row, 'UserId')).filter(Boolean))
        .size
    : null;
  kpis.errors = data.has('ErrorCode')
    ? data.rows.filter((row) => data.text(row, 'ErrorCode') !== '').length
    : null;
  return { kpis, text: {}, datasets };
}

const BUILDERS: Record<
  AnalyticsReportTypeId,
  (
    tables: readonly DerivedTable[],
  ) => Omit<FileRollup, 'version' | 'blobVersion' | 'reportType'>
> = {
  usage: buildUsage,
  rebilling: buildRebilling,
  emissions: buildEmissions,
  'raw-telemetry': buildTelemetry,
};

/**
 * @param tables every table of the file, with the report type's
 *   {@link ROLLUP_FULL_SHEETS} read in full.
 */
export function buildRollup(
  reportType: AnalyticsReportTypeId,
  blobVersion: string,
  tables: readonly DerivedTable[],
): FileRollup {
  return {
    version: ROLLUP_VERSION,
    blobVersion,
    reportType,
    ...BUILDERS[reportType](tables),
  };
}
