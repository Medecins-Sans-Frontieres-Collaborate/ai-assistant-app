import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  TimelineScale,
  computeTimelineScale,
} from '@/lib/utils/shared/geo/timelineScale';

import { MapFeature } from '@/types/workflow';

import { DateRangeFilter } from '@/components/Workflows/Map/DateRangeFilter';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const feature = (overrides: Partial<MapFeature> = {}): MapFeature => ({
  id: 'f1',
  name: 'Goma',
  description: '',
  lat: 1,
  lon: 1,
  confidence: 'high',
  confidenceReason: '',
  category: 'city',
  ...overrides,
});

function eras() {
  const scale = computeTimelineScale(
    [
      feature({ id: 'h1', eventStart: '1812' }),
      feature({ id: 'e1', eventStart: '2026-03-12' }),
      feature({ id: 'e2', eventStart: '2026-04-01' }),
      feature({ id: 'e3', eventStart: '2026-05-01' }),
    ],
    Date.UTC(2026, 5, 10),
  ) as TimelineScale;
  return scale.segments;
}

function renderFilter(
  overrides: Partial<React.ComponentProps<typeof DateRangeFilter>> = {},
) {
  const onChange = vi.fn();
  render(
    <DateRangeFilter
      eras={eras()}
      range={null}
      onChange={onChange}
      showUndated
      onShowUndatedChange={vi.fn()}
      undatedCount={0}
      {...overrides}
    />,
  );
  return { onChange };
}

describe('DateRangeFilter', () => {
  it('era chips filter to the era bounds in one click', () => {
    const segments = eras();
    const { onChange } = renderFilter();
    // The mock i18n doesn't interpolate the aria-label; find by the
    // visible era label instead.
    const chip = screen.getByText('1812').closest('button');
    fireEvent.click(chip as HTMLElement);
    expect(onChange).toHaveBeenCalledWith({
      fromMs: segments[0].startMs,
      // The filter's `toMs` is INCLUSIVE while a segment's `endMs` is
      // exclusive, so the chip stops one ms short of the next era.
      toMs: segments[0].endMs - 1,
    });
  });

  it('an active era chip is pressed and toggles the filter off', () => {
    const segments = eras();
    const { onChange } = renderFilter({
      range: { fromMs: segments[0].startMs, toMs: segments[0].endMs - 1 },
    });
    const chip = screen.getByText('1812').closest('button');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip as HTMLElement);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('custom bounds: from = start of day, to = end of day, independently settable', () => {
    const { onChange } = renderFilter();
    fireEvent.change(screen.getByLabelText('dateFilter.fromAria'), {
      target: { value: '2026-03-01' },
    });
    expect(onChange).toHaveBeenCalledWith({
      fromMs: Date.UTC(2026, 2, 1),
      toMs: null,
    });

    fireEvent.change(screen.getByLabelText('dateFilter.toAria'), {
      target: { value: '2026-06-30' },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      fromMs: null,
      toMs: Date.UTC(2026, 6, 1) - 1,
    });
  });

  it('clear button appears only when active and resets the range', () => {
    expect(
      screen.queryByRole('button', { name: 'dateFilter.clear' }),
    ).not.toBeInTheDocument();
    const { onChange } = renderFilter({
      range: { fromMs: Date.UTC(2026, 0, 1), toMs: null },
    });
    const clear = screen.getByRole('button', { name: 'dateFilter.clear' });
    fireEvent.click(clear);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('undated toggle shows only when active AND undated features exist', () => {
    renderFilter({
      range: { fromMs: Date.UTC(2026, 0, 1), toMs: null },
      undatedCount: 3,
    });
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
