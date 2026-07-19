import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { DataColumn } from '@/types/workflow';

import { InsightsPanel } from '@/components/Workflows/Data/InsightsPanel';

import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';

// The next-intl test mock returns raw keys for this namespace — tests
// assert on keys, like the other Data component suites.

const columns: DataColumn[] = [
  { id: 'region', name: 'Region', type: 'text' },
  { id: 'channel', name: 'Channel', type: 'text' },
  { id: 'cases', name: 'Cases', type: 'number' },
  {
    id: 'cost',
    name: 'Cost',
    type: 'number',
    format: { currency: '$', numberStyle: 'us' },
  },
  { id: 'day', name: 'Day', type: 'date' },
];

const rows = [
  { region: 'North', channel: 'web', cases: 10, cost: 5, day: '2026-01-01' },
  { region: 'North', channel: 'phone', cases: 20, cost: 7, day: '2026-01-02' },
  { region: 'South', channel: 'web', cases: 5, cost: 2, day: '2026-01-03' },
];

function selectKind(kind: string) {
  fireEvent.change(screen.getByLabelText('chartKind'), {
    target: { value: kind },
  });
}

describe('InsightsPanel kinds', () => {
  it('offers scatter only with two numeric columns', () => {
    render(
      <InsightsPanel
        columns={columns.filter((c) => c.id !== 'cost')}
        rows={rows}
      />,
    );
    const options = [
      ...screen.getByLabelText('chartKind').querySelectorAll('option'),
    ].map((o) => o.value);
    expect(options).not.toContain('scatter');
    expect(options).toContain('pivot');
  });

  it('renders a scatter plot for two numeric columns', () => {
    render(<InsightsPanel columns={columns} rows={rows} />);
    selectKind('scatter');
    const svg = screen.getByRole('img', { name: 'chartScatterAria' });
    expect(svg.querySelectorAll('circle').length).toBe(3);
  });

  it('lists min/max/median aggregation options', () => {
    render(<InsightsPanel columns={columns} rows={rows} />);
    const aggSelect = screen.getByLabelText('aggFn');
    const values = [...aggSelect.querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(values).toEqual(
      expect.arrayContaining(['count', 'sum', 'mean', 'min', 'max', 'median']),
    );
  });
});

describe('InsightsPanel split-by', () => {
  it('renders grouped bars and a legend when a split is chosen', () => {
    render(<InsightsPanel columns={columns} rows={rows} />);
    fireEvent.change(screen.getByLabelText('splitByColumn'), {
      target: { value: 'channel' },
    });
    const svg = screen.getByRole('img', { name: 'chartBarAria' });
    // 2 groups × up to 2 series, minus null holes: North has both, South web only.
    expect(svg.querySelectorAll('rect').length).toBe(3);
    // Legend chips for both series keys.
    expect(screen.getByTitle('web')).toBeInTheDocument();
    expect(screen.getByTitle('phone')).toBeInTheDocument();
  });

  it('excludes the bar group column from split candidates', () => {
    render(<InsightsPanel columns={columns} rows={rows} />);
    const split = screen.getByLabelText('splitByColumn');
    const values = [...split.querySelectorAll('option')].map((o) => o.value);
    expect(values).not.toContain('region');
    expect(values).toContain('channel');
  });
});

describe('InsightsPanel pivot', () => {
  it('renders a pivot table with count and formatted currency cells', () => {
    render(<InsightsPanel columns={columns} rows={rows} />);
    selectKind('pivot');
    fireEvent.change(screen.getByLabelText('aggFn'), {
      target: { value: 'sum' },
    });
    const region = screen.getByRole('region', { name: 'pivotTableAria' });
    expect(region.querySelector('table')).toBeInTheDocument();
    // Header: group column + count + value columns.
    expect(within(region).getByText('Region')).toBeInTheDocument();
    expect(within(region).getByText('aggCount')).toBeInTheDocument();
    // North: cases 30, cost $12 (currency format applied).
    expect(within(region).getByText('30')).toBeInTheDocument();
    expect(within(region).getByText('$12')).toBeInTheDocument();
  });

  it('falls back to a count-only pivot without numeric columns', () => {
    render(
      <InsightsPanel
        columns={columns.filter((c) => c.type !== 'number')}
        rows={rows}
      />,
    );
    selectKind('pivot');
    expect(screen.queryByLabelText('aggFn')).not.toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'pivotTableAria' });
    expect(region).toBeInTheDocument();
    // North appears with count 2.
    expect(screen.getByText('North')).toBeInTheDocument();
  });
});
