import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import {
  BarList,
  DivergingBarList,
  foldTail,
  mergeByLabel,
} from '@/components/Charts/BarList';
import { ChartCard } from '@/components/Charts/ChartCard';
import { TimeChart } from '@/components/Charts/TimeChart';
import {
  formatCompact,
  formatFull,
  formatTick,
  niceScale,
} from '@/components/Charts/format';
import { MAX_SERIES, OTHER, SERIES } from '@/components/Charts/palette';

import { describe, expect, it } from 'vitest';

describe('number formatting', () => {
  it('keeps five digits whole and compacts beyond', () => {
    expect(formatCompact(222, 'en')).toBe('222');
    expect(formatCompact(19029, 'en')).toBe('19,029');
    expect(formatCompact(217110, 'en')).toBe('217.1K');
    expect(formatCompact(26_423_960, 'en')).toBe('26.4M');
    expect(formatCompact(85.72, 'en')).toBe('85.7');
    expect(formatCompact(1.3226, 'en')).toBe('1.32');
  });

  it('keeps axis ticks short', () => {
    expect(formatTick(2000, 'en')).toBe('2,000');
    expect(formatTick(20000, 'en')).toBe('20K');
    expect(formatTick(0.5, 'en')).toBe('0.5');
  });

  it('never prints a negative zero', () => {
    expect(formatFull(-0, 'en')).toBe('0');
    expect(formatFull(5750.566 - 5750.566000000001, 'en')).toBe('0');
    expect(formatFull(10957.01, 'en')).toBe('10,957.01');
  });

  it('picks a round axis maximum at or above the data', () => {
    expect(niceScale(1378)).toEqual({ max: 2000, step: 500 });
    expect(niceScale(85)).toEqual({ max: 100, step: 25 });
    expect(niceScale(4210)).toEqual({ max: 8000, step: 2000 });
    expect(niceScale(0).max).toBeGreaterThan(0);
  });
});

describe('palette', () => {
  it('offers a fixed, bounded set of series colours with a dark step for each', () => {
    expect(SERIES).toHaveLength(MAX_SERIES);
    for (const color of [...SERIES, OTHER]) {
      expect(color.fill).toMatch(/^fill-\S+ dark:fill-\S+$/);
      expect(color.swatch).toMatch(/^bg-\S+ dark:bg-\S+$/);
    }
  });
});

describe('foldTail', () => {
  const items = [
    { label: 'a', value: 5 },
    { label: 'b', value: 9 },
    { label: 'c', value: 1 },
    { label: 'd', value: 3 },
  ];
  const rest = (count: number) => `${count} others`;

  it('keeps the largest and sums the rest into one muted row', () => {
    expect(foldTail(items, 2, rest)).toEqual([
      { label: 'b', value: 9 },
      { label: 'a', value: 5 },
      { label: '2 others', value: 4, muted: true },
    ]);
  });

  it('does not hide a single item behind "1 other"', () => {
    expect(foldTail(items, 3, rest).map((item) => item.label)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
  });

  it('keeps an already-folded row at the bottom, never ranked among the names', () => {
    const withSmall = [
      ...items,
      { label: 'small groups', value: 99, muted: true },
    ];
    const folded = foldTail(withSmall, 2, rest);
    expect(folded.map((item) => item.label)).toEqual([
      'b',
      'a',
      '2 others',
      'small groups',
    ]);
  });

  it('merges rows that share a label', () => {
    expect(
      mergeByLabel([
        { label: 'x', value: 1 },
        { label: 'y', value: 2 },
        { label: 'x', value: 4 },
      ]),
    ).toEqual([
      { label: 'x', value: 5 },
      { label: 'y', value: 2 },
    ]);
  });
});

describe('BarList', () => {
  it('writes every value at its bar, so nothing depends on hovering', () => {
    render(
      <BarList
        ariaLabel="By department"
        unit="g"
        items={[
          { label: 'Strategy & Organisational Development', value: 319 },
          { label: 'Fundraising', value: 184.2 },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'By department' });
    // The long name is there in full, not truncated to a dozen characters.
    expect(
      within(list).getByText('Strategy & Organisational Development'),
    ).toBeInTheDocument();
    expect(within(list).getByText('319 g')).toBeInTheDocument();
    // Three-digit values need no decimals at a bar's tip.
    expect(within(list).getByText('184 g')).toBeInTheDocument();
  });

  it('shows the direction of a change in the number, not only the colour', () => {
    render(
      <DivergingBarList
        ariaLabel="Changes"
        items={[
          { label: 'Germany', value: 825.62 },
          { label: 'Austria', value: -825 },
        ]}
      />,
    );
    expect(screen.getByText('+826')).toBeInTheDocument();
    expect(screen.getByText('−825')).toBeInTheDocument();
  });
});

describe('ChartCard', () => {
  it('switches between the chart and the same figures as a table', () => {
    render(
      <ChartCard
        title="Billed by section"
        table={{
          columns: ['Section', 'Billed'],
          rows: [
            ['OC Amsterdam', 4209.76],
            ['Norway', null],
          ],
        }}
      >
        <p>the chart</p>
      </ChartCard>,
    );
    expect(screen.getByText('the chart')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'showTable' }));
    expect(screen.queryByText('the chart')).not.toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('4,209.76')).toBeInTheDocument();
    // A missing value is shown as missing, not as zero.
    expect(within(table).getByText('—')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'showChart' }));
    expect(screen.getByText('the chart')).toBeInTheDocument();
  });
});

describe('TimeChart', () => {
  const categories = ['Jul 1', 'Jul 2', 'Jul 3'];

  it('has no legend for one series — the title already names it', () => {
    const { container } = render(
      <TimeChart
        kind="line"
        ariaLabel="Active people"
        categories={categories}
        series={[{ name: 'People', values: [73, 71, 63], color: SERIES[0] }]}
      />,
    );
    expect(container.querySelector('ul')).toBeNull();
    expect(container.querySelector('path')).not.toBeNull();
  });

  it('always has a legend for two or more series', () => {
    render(
      <TimeChart
        kind="column"
        ariaLabel="People by location"
        categories={categories}
        series={[
          { name: 'Headquarters', values: [67, 67, 59], color: SERIES[0] },
          { name: 'Field', values: [5, 4, 4], color: SERIES[1] },
        ]}
      />,
    );
    const legend = screen.getByRole('list');
    expect(within(legend).getByText('Headquarters')).toBeInTheDocument();
    expect(within(legend).getByText('Field')).toBeInTheDocument();
  });

  it('reads out every series at a position from the keyboard, with the stack total', () => {
    render(
      <TimeChart
        kind="column"
        ariaLabel="People by location"
        totalLabel="All locations"
        categories={categories}
        series={[
          { name: 'Headquarters', values: [67, 67, 59], color: SERIES[0] },
          { name: 'Field', values: [5, 4, null], color: SERIES[1] },
        ]}
      />,
    );
    const chart = screen.getByRole('group', { name: 'People by location' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Focus lands on the latest position.
    fireEvent.focus(chart);
    let readout = screen.getByRole('status');
    expect(within(readout).getByText('Jul 3')).toBeInTheDocument();
    // Once as the series' value, once as the stack total (the other series
    // has nothing there).
    expect(within(readout).getAllByText('59')).toHaveLength(2);
    // No data is shown as no data, not as zero.
    expect(within(readout).getByText('—')).toBeInTheDocument();

    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    readout = screen.getByRole('status');
    expect(within(readout).getByText('Jul 1')).toBeInTheDocument();
    expect(within(readout).getByText('67')).toBeInTheDocument();
    expect(within(readout).getByText('72')).toBeInTheDocument();
    expect(within(readout).getByText('All locations')).toBeInTheDocument();

    // It stops at the first position rather than wrapping.
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(
      within(screen.getByRole('status')).getByText('Jul 1'),
    ).toBeInTheDocument();

    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('draws one mark per value and leaves a gap where there is none', () => {
    const { container } = render(
      <TimeChart
        kind="column"
        ariaLabel="Interactions"
        categories={categories}
        series={[
          { name: 'Interactions', values: [681, null, 486], color: SERIES[0] },
        ]}
      />,
    );
    expect(container.querySelectorAll('svg path')).toHaveLength(2);
  });
});
