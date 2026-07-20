import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { MapFeature } from '@/types/workflow';

import { FeatureList } from '@/components/Workflows/Map/FeatureList';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// jsdom has no layout — render every row (tiny fixtures).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 64,
    measureElement: () => undefined,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 64,
      })),
  }),
}));

const LONG_A = 'Field hospital overwhelmed after the March 12 earthquake.';
const LONG_B = 'Historical parallel: the 1812 earthquake destroyed the port.';

const features: MapFeature[] = [
  {
    id: 'a',
    name: 'Goma',
    description: LONG_A,
    lat: 1,
    lon: 1,
    confidence: 'high',
    confidenceReason: '',
    category: 'health',
    parentName: 'North Kivu',
    countryCode: 'CD',
  },
  {
    id: 'b',
    name: 'Caracas',
    description: LONG_B,
    lat: 2,
    lon: 2,
    confidence: 'low',
    confidenceReason: 'Approximate historical location',
    category: 'earthquake',
  },
];

function renderList() {
  const onFocus = vi.fn();
  const onRemove = vi.fn();
  render(
    <FeatureList
      sourceLabel={() => null}
      features={features}
      onFocus={onFocus}
      onRemove={onRemove}
    />,
  );
  return { onFocus, onRemove };
}

describe('FeatureList accordion', () => {
  it('rows collapse long text until expanded', () => {
    renderList();
    const description = screen.getByText(LONG_A);
    expect(description).toHaveClass('truncate');

    // The mock i18n falls back to raw keys, so both rows' expand buttons
    // share a name — take the first.
    fireEvent.click(
      screen.getAllByRole('button', { name: 'map.expandFeature' })[0],
    );
    expect(screen.getByText(LONG_A)).not.toHaveClass('truncate');
    expect(screen.getByText(LONG_A)).toHaveClass('whitespace-pre-wrap');
    // Expanded details include the parent/country line.
    expect(screen.getByText(/map.detailsParent · CD/)).toBeInTheDocument();
  });

  it('only one row is expanded at a time', () => {
    renderList();
    const expandButtons = screen.getAllByRole('button', {
      name: /map\.(expand|collapse)Feature/,
    });
    fireEvent.click(expandButtons[0]);
    expect(
      screen.getAllByRole('button', { name: 'map.collapseFeature' }),
    ).toHaveLength(1);

    // Expanding the second collapses the first.
    fireEvent.click(
      screen.getAllByRole('button', { name: 'map.expandFeature' })[0],
    );
    const collapse = screen.getAllByRole('button', {
      name: 'map.collapseFeature',
    });
    expect(collapse).toHaveLength(1);
    expect(collapse[0]).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(LONG_A)).toHaveClass('truncate');
    expect(screen.getByText(LONG_B)).not.toHaveClass('truncate');
  });

  it('expanding again collapses (toggle) and fly/remove still work', () => {
    const { onFocus, onRemove } = renderList();
    const expand = screen.getAllByRole('button', {
      name: 'map.expandFeature',
    })[0];
    fireEvent.click(expand);
    fireEvent.click(
      screen.getByRole('button', { name: 'map.collapseFeature' }),
    );
    expect(
      screen.queryByRole('button', { name: 'map.collapseFeature' }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'map.flyTo' })[0]);
    expect(onFocus).toHaveBeenCalledWith('a');
    fireEvent.click(
      screen.getAllByRole('button', { name: 'map.removeFeature' })[1],
    );
    expect(onRemove).toHaveBeenCalledWith('b');
  });
});
