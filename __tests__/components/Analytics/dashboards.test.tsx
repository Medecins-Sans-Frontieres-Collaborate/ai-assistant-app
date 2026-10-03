import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import {
  AnalyticsDashboardResponse,
  AnalyticsFileDto,
} from '@/lib/services/analytics/dto';
import { SMALL_GROUPS_LABEL } from '@/lib/services/analytics/rollup';
import { RollupView } from '@/lib/services/analytics/rollupModel';

import { EMISSIONS_ASSUMPTIONS } from '@/lib/utils/shared/emissions';

import { FilePreview } from '@/components/Analytics/FilePreview';
import { DashboardView } from '@/components/Analytics/dashboards/DashboardView';
import { EmissionsDashboard } from '@/components/Analytics/dashboards/EmissionsDashboard';
import { RebillingDashboard } from '@/components/Analytics/dashboards/RebillingDashboard';
import { TrendPanel } from '@/components/Analytics/dashboards/TrendPanel';
import { UsageDashboard } from '@/components/Analytics/dashboards/UsageDashboard';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  dashboard: null as unknown,
  trend: undefined as unknown,
  previewRequested: [] as (string | null)[],
}));

vi.mock('@/client/hooks/analytics/useAnalytics', () => ({
  useAnalyticsDashboard: () => ({
    data: world.dashboard,
    isLoading: false,
    isError: world.dashboard === null,
    refetch: vi.fn(),
  }),
  useAnalyticsTrend: () => ({ data: world.trend }),
  useAnalyticsPreview: (fileId: string | null) => {
    world.previewRequested.push(fileId);
    return {
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useAnalyticsTable: () => ({
    data: undefined,
    isLoading: true,
    isError: false,
  }),
  analyticsDownloadUrl: (id: string) => `/download?id=${id}`,
  analyticsExportUrl: (id: string, format: string) =>
    `/export?id=${id}&format=${format}`,
}));

function view(overrides: Partial<RollupView>): RollupView {
  return {
    reportType: 'usage',
    kpis: {},
    text: {},
    datasets: {},
    withheld: [],
    assumptions: null,
    ...overrides,
  };
}

const USAGE = view({
  kpis: {
    users: 222,
    interactions: 19029,
    avgPerUser: 85.72,
    all_avgPerUser: 83.11,
    shareUsers: 6.7,
  },
  text: { slice: 'OCBA', comparator: 'All MSF' },
  datasets: {
    daily: {
      columns: ['date', 'users', 'interactions'],
      rows: [
        ['2026-07-01', 73, 681],
        ['2026-07-02', 71, 603],
      ],
      folded: false,
    },
    byDepartment: {
      columns: ['group', 'users', 'interactions'],
      rows: [
        ['Logistics', 18, 2442],
        [SMALL_GROUPS_LABEL, 9, 734],
      ],
      folded: true,
    },
  },
  withheld: ['byJobTitle'],
});

/** The card (figure) with this title. */
function card(title: string): HTMLElement {
  return screen.getByRole('figure', { name: title });
}

describe('UsageDashboard', () => {
  it('leads with the headline figures, read against their comparator', () => {
    render(<UsageDashboard view={USAGE} />);
    const users = screen.getByText('usage.users').closest('div')!;
    expect(within(users).getByText('222')).toBeInTheDocument();
    expect(screen.getByText('19,029')).toBeInTheDocument();
    // A figure the report did not provide is shown as missing, not as zero.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('names the folded row and says that folding happened', () => {
    render(<UsageDashboard view={USAGE} />);
    const departments = card('usage.departments');
    expect(within(departments).getByText('Logistics')).toBeInTheDocument();
    expect(within(departments).getByText('smallGroups')).toBeInTheDocument();
    expect(within(departments).getByText('foldedNote')).toBeInTheDocument();
    // The sentinel itself never reaches the screen.
    expect(departments.textContent).not.toContain('small-groups');
  });

  it('says WHY a panel is absent: hidden by the settings, or not in this file', () => {
    render(<UsageDashboard view={USAGE} />);
    const jobTitles = screen.getByText('usage.jobTitles').parentElement!;
    expect(within(jobTitles).getByText('hiddenPanel')).toBeInTheDocument();
    const models = screen.getByText('usage.models').parentElement!;
    expect(within(models).getByText('missingPanel')).toBeInTheDocument();
  });

  it('falls back to a plain count of people when the location split is withheld', () => {
    render(<UsageDashboard view={USAGE} />);
    const people = card('usage.dailyUsers');
    // One series: no legend, and no location names.
    expect(within(people).queryByText('usage.location.hq')).toBeNull();
    expect(within(people).queryByRole('list')).toBeNull();
  });

  it('gives every chart a table of the same figures', () => {
    render(<UsageDashboard view={USAGE} />);
    const daily = card('usage.daily');
    fireEvent.click(within(daily).getByRole('button', { name: 'showTable' }));
    const table = within(daily).getByRole('table');
    expect(within(table).getByText('681')).toBeInTheDocument();
    expect(within(table).getByText('603')).toBeInTheDocument();
  });
});

describe('RebillingDashboard', () => {
  const REBILLING = view({
    reportType: 'rebilling',
    kpis: { totalBilled: 10957.01, sections: 36, usageEvents: 217110 },
    text: { currency: 'USD' },
    datasets: {
      bySection: {
        columns: [
          'section',
          'usageEvents',
          'usagePct',
          'infrastructure',
          'usage',
          'billed',
        ],
        rows: [
          ['OC Amsterdam', 85869, 39.55, 9.35, 4200.41, 4209.76],
          ['Germany', 16687, 7.69, 9.35, 816.27, 825.62],
        ],
        folded: false,
      },
      changes: {
        columns: ['section', 'previous', 'restated', 'change'],
        rows: [
          ['OC Amsterdam', 4209.76, 4209.76, 0],
          ['Germany', 825.62, 825.62, 0],
        ],
        folded: false,
      },
    },
  });

  it('shows money in full — a bill is not rounded to "11K"', () => {
    render(<RebillingDashboard view={REBILLING} />);
    expect(screen.getByText('10,957.01')).toBeInTheDocument();
    // Counts may be compacted.
    expect(screen.getByText('217.1K')).toBeInTheDocument();
  });

  it('says nothing changed rather than drawing an empty chart', () => {
    render(<RebillingDashboard view={REBILLING} />);
    expect(
      within(card('rebilling.changes')).getByText('rebilling.noChanges'),
    ).toBeInTheDocument();
  });
});

describe('EmissionsDashboard', () => {
  const delivered = {
    ...EMISSIONS_ASSUMPTIONS,
    assumptionsVersion: 'report-v1',
    // Twice the app's overhead: the two sets must give different answers.
    pue: EMISSIONS_ASSUMPTIONS.pue * 2,
    smartphoneChargeGrams: 13.5,
  };
  const EMISSIONS = view({
    reportType: 'emissions',
    kpis: { activeUsers: 181, requests: 20, loggedWh: 1, loggedCO2g: 1 },
    assumptions: delivered,
    datasets: {
      recalc: {
        columns: [
          'sizeClass',
          'dedicatedReasoner',
          'region',
          'effort',
          'requests',
          'promptTokens',
          'completionTokens',
          'loggedWh',
          'loggedCO2g',
        ],
        rows: [['standard', false, 'EU', 'none', 20, 0, 1_000_000, 1, 1]],
        folded: false,
      },
    },
  });
  // 1,000,000 completion tokens → 1,000 × Wh-per-1k(standard) × PUE.
  const wh = (pue: number) =>
    Math.round(1000 * EMISSIONS_ASSUMPTIONS.whPer1kTokens.standard * pue);
  const energyTile = () => screen.getByText('emissions.energy').closest('div')!;

  it('opens on the report’s own assumptions', () => {
    render(<EmissionsDashboard view={EMISSIONS} />);
    expect(
      screen.getByRole('radio', { name: 'emissions.delivered' }),
    ).toBeChecked();
    expect(energyTile().textContent).toContain(String(wh(delivered.pue)));
    // Nothing to compare against when this IS as delivered.
    expect(
      within(energyTile()).queryByText('emissions.vsDelivered'),
    ).toBeNull();
  });

  it('recalculates everything when the reader switches to the app’s current set', () => {
    render(<EmissionsDashboard view={EMISSIONS} />);
    fireEvent.click(screen.getByRole('radio', { name: 'emissions.current' }));
    expect(energyTile().textContent).toContain(
      String(wh(EMISSIONS_ASSUMPTIONS.pue)),
    );
    expect(
      within(energyTile()).getByText('emissions.vsDelivered'),
    ).toBeInTheDocument();
  });

  it('lets a figure be changed in what-if, starting from what was on screen', () => {
    render(<EmissionsDashboard view={EMISSIONS} />);
    fireEvent.click(screen.getByRole('radio', { name: 'emissions.whatIf' }));
    const pue = screen.getByLabelText('emissions.factor.pue');
    expect(pue).toHaveValue(delivered.pue);
    expect(
      within(energyTile()).getByText('emissions.sameAsDelivered'),
    ).toBeInTheDocument();

    fireEvent.change(pue, { target: { value: '1' } });
    expect(energyTile().textContent).toContain(String(wh(1)));

    // A nonsense entry is ignored rather than turning the page into NaN.
    fireEvent.change(pue, { target: { value: '-3' } });
    expect(energyTile().textContent).toContain(String(wh(1)));

    fireEvent.click(
      screen.getByRole('button', { name: 'emissions.resetDelivered' }),
    );
    expect(energyTile().textContent).toContain(String(wh(delivered.pue)));
  });

  it('falls back to the app’s set, and says so, when the report’s own could not be read', () => {
    render(<EmissionsDashboard view={{ ...EMISSIONS, assumptions: null }} />);
    expect(
      screen.getByRole('radio', { name: 'emissions.delivered' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('radio', { name: 'emissions.current' }),
    ).toBeChecked();
    expect(
      screen.getByText('emissions.deliveredUnavailable'),
    ).toBeInTheDocument();
  });

  it('says how many requests an assumption set cannot price', () => {
    const odd = {
      ...EMISSIONS,
      datasets: {
        recalc: {
          ...EMISSIONS.datasets.recalc,
          rows: [['colossal', false, 'EU', 'none', 7, 0, 1000, 0, 0]],
        },
      },
    };
    render(<EmissionsDashboard view={odd} />);
    expect(screen.getByText('emissions.unpriced')).toBeInTheDocument();
  });
});

describe('DashboardView', () => {
  const response = (
    reportType: RollupView['reportType'],
  ): AnalyticsDashboardResponse => ({
    ...view({ reportType }),
    file: { id: 'a'.repeat(32), name: 'report.xlsx' },
    period: null,
    access: 'view',
  });

  it('draws the dashboard that matches the report type', () => {
    world.dashboard = response('rebilling');
    const { unmount } = render(<DashboardView fileId="x" />);
    expect(screen.getByText('rebilling.totalBilled')).toBeInTheDocument();
    unmount();

    world.dashboard = response('raw-telemetry');
    render(<DashboardView fileId="x" />);
    expect(screen.getByText('telemetry.events')).toBeInTheDocument();
  });

  it('reports a dashboard that could not be loaded', () => {
    world.dashboard = null;
    render(<DashboardView fileId="x" />);
    expect(screen.getByRole('alert')).toHaveTextContent('failed');
  });
});

describe('TrendPanel', () => {
  const point = (month: string, users: number) => ({
    ...view({ kpis: { users, interactions: users * 80 } }),
    file: { id: month, name: month },
    period: { from: `${month}-01`, to: `${month}-28` },
  });

  it('draws nothing when the folder holds no run of reports', () => {
    world.trend = { reportType: null, status: 'none', points: [] };
    const { container } = render(<TrendPanel folder="usage" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains a folder with several reports per period instead of summing them', () => {
    world.trend = {
      reportType: 'usage',
      status: 'several-per-period',
      points: [],
    };
    render(<TrendPanel folder="usage" />);
    expect(screen.getByText('trend.severalPerPeriod')).toBeInTheDocument();
    expect(screen.queryByRole('figure')).toBeNull();
  });

  it('plots people and interactions as two charts, never one with two axes', () => {
    world.trend = {
      reportType: 'usage',
      status: 'ok',
      points: [point('2026-06', 200), point('2026-07', 222)],
    };
    render(<TrendPanel folder="usage/ocba" />);
    expect(screen.getAllByRole('figure')).toHaveLength(2);
    expect(card('trend.users')).toBeInTheDocument();
    expect(card('trend.interactions')).toBeInTheDocument();
  });
});

describe('FilePreview with a dashboard', () => {
  const FILE: AnalyticsFileDto = {
    id: 'a'.repeat(32),
    name: 'ocba_report_2026-07-01_to_2026-07-31.xlsx',
    size: 1000,
    period: { from: '2026-07-01', to: '2026-07-31' },
    deliveredAt: '2026-08-03T08:00:00.000Z',
    expiresAt: '2028-08-01T00:00:00.000Z',
    canDownload: true,
    downloadBlock: null,
    canPreview: true,
    canExport: true,
    canViewDashboard: true,
  };

  beforeEach(() => {
    world.dashboard = {
      ...USAGE,
      file: { id: FILE.id, name: FILE.name },
      period: FILE.period,
      access: 'download',
    };
    world.previewRequested = [];
  });

  it('opens on the overview, with the tables one click away', () => {
    render(<FilePreview file={FILE} folderLabel="OCBA" onBack={vi.fn()} />);
    expect(
      screen.getByRole('button', { name: 'preview.section.overview' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('usage.users')).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'preview.section.tables' }),
    );
    expect(screen.queryByText('usage.users')).not.toBeInTheDocument();
  });

  it('offers no section switch when the file has no dashboard', () => {
    render(
      <FilePreview
        file={{ ...FILE, canViewDashboard: false }}
        folderLabel="OCBA"
        onBack={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('button', { name: 'preview.section.overview' }),
    ).toBeNull();
  });
});
