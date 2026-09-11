import { fireEvent, render, screen, within } from '@testing-library/react';

import { PreparedImport } from '@/client/services/workflows/map/mapImport';

import { detectMapping } from '@/lib/utils/shared/geo/importFields';
import { parseDelimited } from '@/lib/utils/shared/geo/importParse';

import { ImportDialog } from '@/components/Workflows/Map/ImportDialog';

import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function prepared(csv: string, sourceName = 'sites.csv'): PreparedImport {
  const parsed = parseDelimited(csv, 'csv');
  return {
    sourceName,
    format: 'csv',
    parsed,
    detected: detectMapping(parsed.headers),
  };
}

const CLEAN =
  'name,lat,lon,category,description,country_code\nGoma,-1.6585,29.2205,city,Big town,CD\nBukavu,-2.5083,28.8628,city,Lake town,CD\n';

describe('ImportDialog', () => {
  beforeEach(() => {
    useSettingsStore.setState({ mapImportDefaultConfidence: 'high' });
  });

  it('goes straight to a summary for a file with recognisable headers', () => {
    render(
      <ImportDialog
        source={prepared(CLEAN)}
        existing={[]}
        capacity={100}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('summary')).toBeInTheDocument();
    // No mapping step: nothing was unresolved.
    expect(screen.queryByText('mapping.needed')).toBeNull();
    expect(screen.getByRole('button', { name: 'confirm' })).toBeEnabled();
  });

  it('asks for columns when a required field cannot be found', () => {
    const onConfirm = vi.fn();
    render(
      <ImportDialog
        source={prepared('place,northing,easting\nGoma,-1.6585,29.2205\n')}
        existing={[]}
        capacity={100}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('mapping.needed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirm' })).toBeDisabled();

    // Bind the two coordinate columns; name resolved by alias already.
    const selects = screen.getAllByRole('combobox');
    const byLabel = (label: string) =>
      selects.find((s) =>
        s.closest('label')?.textContent?.startsWith(`fields.${label}`),
      )!;
    fireEvent.change(byLabel('lat'), { target: { value: 'northing' } });
    fireEvent.change(byLabel('lon'), { target: { value: 'easting' } });

    expect(screen.getByRole('button', { name: 'confirm' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0].features[0]).toMatchObject({
      name: 'Goma',
      lat: -1.6585,
      lon: 29.2205,
    });
  });

  it('lets a small import set confidence per row, over the file default', () => {
    const onConfirm = vi.fn();
    render(
      <ImportDialog
        source={prepared(CLEAN)}
        existing={[]}
        capacity={100}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const rows = screen.getByText('rows.title').parentElement!;
    // Rows are listed in file order; Goma is first.
    const [gomaSelect] = within(rows).getAllByRole('combobox');
    fireEvent.change(gomaSelect, { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));

    const features = onConfirm.mock.calls[0][0].features;
    expect(
      features.find((f: { name: string }) => f.name === 'Goma').confidence,
    ).toBe('low');
    expect(
      features.find((f: { name: string }) => f.name === 'Bukavu').confidence,
    ).toBe('high');
  });

  it('remembers the chosen default confidence for next time', () => {
    const onConfirm = vi.fn();
    render(
      <ImportDialog
        source={prepared(CLEAN)}
        existing={[]}
        capacity={100}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const defaultSelect = screen
      .getByText('defaultConfidence.label')
      .parentElement!.querySelector('select')!;
    fireEvent.change(defaultSelect, { target: { value: 'medium' } });
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(useSettingsStore.getState().mapImportDefaultConfidence).toBe(
      'medium',
    );
    expect(onConfirm.mock.calls[0][0].features[0].confidence).toBe('medium');
  });

  it('offers AI enrichment only when something is missing, and passes the choice on', () => {
    const onConfirm = vi.fn();
    const { unmount } = render(
      <ImportDialog
        source={prepared(CLEAN)}
        existing={[]}
        capacity={100}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    // Category, description and country all present: nothing to fill.
    expect(screen.queryByText('enrich.label')).toBeNull();
    unmount();

    render(
      <ImportDialog
        source={prepared('name,lat,lon\nGoma,-1.6585,29.2205\n')}
        existing={[]}
        capacity={100}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'confirm' }));
    expect(onConfirm.mock.calls[0][0].enrich).toBe(true);
  });

  it('reports skipped rows and duplicates in the summary', () => {
    render(
      <ImportDialog
        source={prepared('name,lat,lon\nGoma,-1.6585,29.2205\nNowhere,,\n')}
        existing={[{ name: 'Goma', lat: -1.6585, lon: 29.2205 }]}
        capacity={100}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('skipped.no_coordinates')).toBeInTheDocument();
    expect(screen.getByText('skipped.duplicate')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirm' })).toBeDisabled();
  });

  it('opens the field guide with required and optional fields', () => {
    render(
      <ImportDialog
        source={prepared(CLEAN)}
        existing={[]}
        capacity={100}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /guide\.title/ }));
    expect(screen.getByText('guide.required')).toBeInTheDocument();
    expect(screen.getByText('guide.optional')).toBeInTheDocument();
    expect(screen.getByText('country_code')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /guide\.download/ }),
    ).toBeInTheDocument();
  });
});
