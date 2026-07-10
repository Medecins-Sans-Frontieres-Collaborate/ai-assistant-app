import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import {
  TimelineScale,
  computeTimelineScale,
  stepToMs,
} from '@/lib/utils/shared/geo/timelineScale';

import { MapFeature } from '@/types/workflow';

import { TimelineControl } from '@/components/Workflows/Map/TimelineControl';

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

const NOW = Date.UTC(2026, 5, 10);

function denseScale(): TimelineScale {
  return computeTimelineScale(
    [
      feature({ id: 'a', eventStart: '2026-03-12' }),
      feature({ id: 'b', eventStart: '2026-04-01' }),
      feature({ id: 'c', eventStart: '2026-05-01' }),
    ],
    NOW,
  ) as TimelineScale;
}

function multiEraScale(): TimelineScale {
  return computeTimelineScale(
    [
      feature({ id: 'h1', eventStart: '1812' }),
      feature({ id: 'h2', eventStart: '1875' }),
      feature({ id: 'e1', eventStart: '2026-03-12' }),
      feature({ id: 'e2', eventStart: '2026-04-01' }),
      feature({ id: 'e3', eventStart: '2026-05-01', eventOngoing: true }),
    ],
    NOW,
  ) as TimelineScale;
}

function renderControl(
  scale: TimelineScale,
  overrides: Partial<React.ComponentProps<typeof TimelineControl>> = {},
) {
  const onTimeChange = vi.fn();
  render(
    <TimelineControl
      scale={scale}
      timeMs={scale.minMs}
      onTimeChange={onTimeChange}
      playing={false}
      onPlayToggle={vi.fn()}
      showUndated
      onShowUndatedChange={vi.fn()}
      activeCount={3}
      {...overrides}
    />,
  );
  return { onTimeChange };
}

describe('TimelineControl', () => {
  it('drives the slider over step indices', () => {
    const scale = denseScale();
    const { onTimeChange } = renderControl(scale);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '0');
    expect(slider).toHaveAttribute('max', String(scale.totalSteps - 1));
    expect(slider).toHaveAttribute('step', '1');

    fireEvent.change(slider, { target: { value: '5' } });
    expect(onTimeChange).toHaveBeenCalledWith(stepToMs(scale, 5));
  });

  it('single era: end labels, no era strip', () => {
    const scale = denseScale();
    renderControl(scale);
    expect(scale.segments).toHaveLength(1);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    // Max end label present (day-precision inside a day-stepped span);
    // the min label doubles with the current-date readout at minMs.
    expect(screen.getByText('May 1, 2026')).toBeInTheDocument();
  });

  it('multi era: strip buttons jump to segment starts, active era marked', () => {
    const scale = multiEraScale();
    expect(scale.segments.length).toBeGreaterThan(1);
    const { onTimeChange } = renderControl(scale);

    const strip = screen.getByRole('group');
    expect(strip).toBeInTheDocument();
    const eraButtons = screen.getAllByRole('button', {
      name: /map\.timeline\.jumpTo/,
    });
    expect(eraButtons).toHaveLength(scale.segments.length);
    // timeMs = minMs → the first era is current.
    expect(eraButtons[0]).toHaveAttribute('aria-current', 'true');

    fireEvent.click(eraButtons[eraButtons.length - 1]);
    const lastSegment = scale.segments[scale.segments.length - 1];
    expect(onTimeChange).toHaveBeenCalledWith(
      stepToMs(scale, lastSegment.firstStepIndex),
    );
  });

  it('label precision follows the active segment step', () => {
    const scale = multiEraScale();
    // Inside the sparse 1812 era (span-sized step): month/year label.
    renderControl(scale, { timeMs: scale.minMs });
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuetext', 'Jan 1812');
  });
});
