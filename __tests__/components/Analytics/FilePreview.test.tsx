import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { AnalyticsFileDto } from '@/lib/services/analytics/dto';
import { TableSummary, TableView } from '@/lib/services/analytics/previewModel';

import { FilePreview } from '@/components/Analytics/FilePreview';
import { filterRows, sortRows } from '@/components/Analytics/PreviewGrid';
import { serializeChart } from '@/components/Analytics/chartExport';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  preview: null as unknown,
  tables: {} as Record<string, unknown>,
  requested: [] as (string | null)[],
}));

vi.mock('@/client/hooks/analytics/useAnalytics', () => ({
  useAnalyticsPreview: () => ({
    data: world.preview,
    isLoading: false,
    isError: world.preview === null,
    refetch: vi.fn(),
  }),
  useAnalyticsTable: (_fileId: string, table: string | null) => {
    world.requested.push(table);
    return {
      data: table === null ? undefined : world.tables[table],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  analyticsDownloadUrl: (id: string) => `/download?id=${id}`,
  analyticsExportUrl: (id: string, format: string, table?: string) =>
    `/export?id=${id}&format=${format}${table ? `&table=${table}` : ''}`,
}));

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
  canViewDashboard: false,
};

function summary(
  name: string,
  overrides: Partial<TableSummary> = {},
): TableSummary {
  return {
    name,
    layout: 'table',
    rowCount: 2,
    shownRows: 2,
    truncated: false,
    rowLevel: false,
    withheld: null,
    ...overrides,
  };
}

const DAILY: TableView = {
  ...summary('Daily'),
  columns: [
    { name: 'date', kind: 'date', field: null, hiddenFromUsers: false },
    {
      name: 'unique_users',
      kind: 'number',
      field: null,
      hiddenFromUsers: false,
    },
    {
      name: 'site',
      kind: 'text',
      field: 'workLocation',
      hiddenFromUsers: false,
    },
  ],
  rows: [
    ['2026-07-01', 73, 'HQ'],
    ['2026-07-02', 71, 'Field'],
  ],
};

function setPreview(tables: TableSummary[], canExport = true) {
  world.preview = {
    file: { id: FILE.id, name: FILE.name },
    access: 'download',
    tables,
    canExport,
    previewRows: 5000,
  };
}

function renderPreview(file: AnalyticsFileDto = FILE) {
  const onBack = vi.fn();
  render(<FilePreview file={file} folderLabel="OCBA" onBack={onBack} />);
  return onBack;
}

describe('FilePreview', () => {
  beforeEach(() => {
    world.tables = { Daily: DAILY };
    world.requested = [];
    setPreview([summary('Daily')]);
  });

  it('opens the first table and offers its exports and the original', () => {
    renderPreview();
    expect(world.requested).toContain('Daily');
    expect(screen.getByText('preview.exportCsv').closest('a')).toHaveAttribute(
      'href',
      `/export?id=${FILE.id}&format=csv&table=Daily`,
    );
    expect(screen.getByText('preview.exportXlsx').closest('a')).toHaveAttribute(
      'href',
      `/export?id=${FILE.id}&format=xlsx`,
    );
    expect(
      screen.getByText('preview.downloadOriginal').closest('a'),
    ).toHaveAttribute('href', `/download?id=${FILE.id}`);
    // Column headers render even though jsdom lays out no virtual rows.
    expect(
      screen.getByRole('button', { name: 'unique_users' }),
    ).toBeInTheDocument();
  });

  it('skips a locked table when choosing what to open, and explains it when clicked', () => {
    setPreview([summary('Users', { withheld: 'row-level' }), summary('Daily')]);
    renderPreview();
    // Opened Daily, never asked for the table it may not have.
    expect(world.requested).not.toContain('Users');

    fireEvent.click(screen.getByRole('tab', { name: 'preview.lockedTab' }));
    expect(screen.getByText('preview.withheld.row-level')).toBeInTheDocument();
    expect(world.requested).not.toContain('Users');
    // No CSV export for a table that cannot be opened.
    expect(screen.queryByText('preview.exportCsv')).not.toBeInTheDocument();
  });

  it('says exports leave hidden fields out when the original is withheld', () => {
    renderPreview({
      ...FILE,
      canDownload: false,
      downloadBlock: 'hidden-fields',
    });
    expect(screen.getByText('preview.exportNote')).toBeInTheDocument();
    expect(
      screen.queryByText('preview.downloadOriginal'),
    ).not.toBeInTheDocument();
  });

  it('offers nothing to export at view level', () => {
    setPreview([summary('Daily')], false);
    renderPreview({ ...FILE, canDownload: false, canExport: false });
    expect(screen.queryByText('preview.exportCsv')).not.toBeInTheDocument();
    expect(screen.queryByText('preview.exportXlsx')).not.toBeInTheDocument();
  });

  it('warns when only part of a table was loaded', () => {
    world.tables = {
      Daily: { ...DAILY, truncated: true, rowCount: 80630 },
    };
    renderPreview();
    expect(screen.getByText('preview.truncated')).toBeInTheDocument();
  });

  it('switches to a chart built from the open table', () => {
    renderPreview();
    fireEvent.click(screen.getByRole('button', { name: 'preview.mode.chart' }));
    // A date column is preferred for the grouping, and draws a line chart.
    expect(screen.getByLabelText('chart.groupBy')).toHaveValue('0');
    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.getByText('chart.savePng')).toBeInTheDocument();
  });

  it('shows a laid-out page without sorting or a chart', () => {
    setPreview([summary('Summary', { layout: 'freeform' })]);
    world.tables = {
      Summary: {
        ...summary('Summary', { layout: 'freeform' }),
        columns: [
          { name: 'A', kind: 'text', field: null, hiddenFromUsers: false },
        ],
        rows: [['Headline figures']],
      },
    };
    renderPreview();
    expect(screen.getByText('preview.freeformNote')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'A' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'preview.mode.chart' }),
    ).not.toBeInTheDocument();
  });

  it('reports a file that cannot be opened, and goes back on request', () => {
    world.preview = null;
    const onBack = renderPreview();
    expect(screen.getByText('preview.unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByText('preview.back'));
    expect(onBack).toHaveBeenCalled();
  });
});

describe('grid helpers', () => {
  const rows = [
    ['Logistics', 12],
    ['medical', 7],
    [null, 30],
    ['Advocacy', null],
  ];

  it('filters on any cell, ignoring case', () => {
    expect(filterRows(rows, ' MED ')).toEqual([['medical', 7]]);
    expect(filterRows(rows, '30')).toEqual([[null, 30]]);
    expect(filterRows(rows, '')).toBe(rows);
  });

  it('sorts numbers numerically and text naturally, blanks last either way', () => {
    expect(
      sortRows(rows, { column: 1, direction: 'desc' }).map((row) => row[1]),
    ).toEqual([30, 12, 7, null]);
    expect(
      sortRows(rows, { column: 1, direction: 'asc' }).map((row) => row[1]),
    ).toEqual([7, 12, 30, null]);
    expect(
      sortRows(rows, { column: 0, direction: 'asc' }).map((row) => row[0]),
    ).toEqual(['Advocacy', 'Logistics', 'medical', null]);
    expect(sortRows(rows, null)).toBe(rows);
  });
});

describe('serializeChart', () => {
  it('writes computed styles onto a copy, drops classes, and adds a background', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<svg viewBox="0 0 640 240"><rect class="fill-blue-500" style="fill: rgb(1, 2, 3)" width="10" height="10"></rect></svg>';
    document.body.appendChild(host);
    const svg = host.querySelector('svg')!;

    const markup = serializeChart(svg);
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).toContain('width="640"');
    expect(markup).toContain('fill="rgb(1, 2, 3)"');
    expect(markup).not.toContain('class=');
    // The live chart is untouched.
    expect(svg.querySelector('rect')!.getAttribute('class')).toBe(
      'fill-blue-500',
    );
    host.remove();
  });
});
