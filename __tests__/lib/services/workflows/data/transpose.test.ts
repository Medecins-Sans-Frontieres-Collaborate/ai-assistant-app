import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';
import {
  detectAttributeMatrix,
  transposeTable,
} from '@/lib/services/workflows/data/transpose';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

/** Comparison-matrix fixture in the shape of a photo-imported table. */
const matrixColumns: DataColumn[] = [
  { id: 'feature', name: 'Feature', type: 'text' },
  { id: 'team', name: 'ChatGPT Team', type: 'text' },
  { id: 'copilot', name: 'M365 Copilot', type: 'text' },
  { id: 'msf', name: 'MSF AI Assistant', type: 'text' },
];

const matrixRows = [
  { feature: 'Cost/user/month (USD)', team: '25', copilot: '200', msf: '3.77' },
  { feature: 'Basic Chats', team: 'Yes', copilot: 'Yes', msf: 'Yes' },
  { feature: 'File Uploads', team: 'Yes', copilot: 'Yes', msf: 'Yes' },
  { feature: 'Image Uploads', team: 'Yes', copilot: 'No', msf: 'Yes' },
  { feature: 'Model Selection', team: 'Yes', copilot: 'No', msf: 'Yes' },
  { feature: 'Integrations', team: 'No', copilot: 'Native', msf: 'Planned' },
  { feature: 'Data Privacy', team: 'Low', copilot: 'Medium', msf: 'High' },
];

describe('detectAttributeMatrix', () => {
  it('detects a comparison matrix (row-consistent, column-mixed types)', () => {
    expect(detectAttributeMatrix(matrixColumns, matrixRows)).toBe(true);
  });

  it('rejects an ordinary all-text table (columns type uniformly)', () => {
    const columns: DataColumn[] = [
      { id: 'name', name: 'Name', type: 'text' },
      { id: 'city', name: 'City', type: 'text' },
      { id: 'country', name: 'Country', type: 'text' },
    ];
    const rows = [
      { name: 'Amina', city: 'Dakar', country: 'Senegal' },
      { name: 'Jonas', city: 'Oslo', country: 'Norway' },
      { name: 'Rin', city: 'Osaka', country: 'Japan' },
    ];
    expect(detectAttributeMatrix(columns, rows)).toBe(false);
  });

  it('rejects a table whose data columns already type cleanly', () => {
    const columns: DataColumn[] = [
      { id: 'region', name: 'Region', type: 'text' },
      { id: 'cases', name: 'Cases', type: 'number' },
      { id: 'deaths', name: 'Deaths', type: 'number' },
    ];
    const rows = [
      { region: 'North', cases: 30, deaths: 1 },
      { region: 'South', cases: 10, deaths: 0 },
      { region: 'East', cases: 20, deaths: 2 },
    ];
    expect(detectAttributeMatrix(columns, rows)).toBe(false);
  });

  it('rejects tables with too few columns or rows', () => {
    expect(detectAttributeMatrix(matrixColumns.slice(0, 2), matrixRows)).toBe(
      false,
    );
    expect(detectAttributeMatrix(matrixColumns, matrixRows.slice(0, 2))).toBe(
      false,
    );
  });

  it('rejects when first-column labels repeat (not a header axis)', () => {
    const rows = matrixRows.map((row) => ({ ...row, feature: 'Same label' }));
    expect(detectAttributeMatrix(matrixColumns, rows)).toBe(false);
  });
});

describe('transposeTable', () => {
  it('flips items into rows and infers per-attribute column types', () => {
    const { columns, rows } = transposeTable(matrixColumns, matrixRows, 'Name');
    expect(columns.map((c) => c.name)).toEqual([
      'Name',
      'Cost/user/month (USD)',
      'Basic Chats',
      'File Uploads',
      'Image Uploads',
      'Model Selection',
      'Integrations',
      'Data Privacy',
    ]);
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('Cost/user/month (USD)')?.type).toBe('number');
    expect(byName.get('Basic Chats')?.type).toBe('boolean');
    expect(byName.get('Data Privacy')?.type).toBe('text');

    expect(rows).toHaveLength(3);
    const first = rows[0];
    expect(first[byName.get('Name')!.id]).toBe('ChatGPT Team');
    expect(first[byName.get('Cost/user/month (USD)')!.id]).toBe(25);
    expect(first[byName.get('Basic Chats')!.id]).toBe(true);
    expect(first[byName.get('Data Privacy')!.id]).toBe('Low');
  });

  it('dedupes repeated attribute labels into distinct headers', () => {
    const columns: DataColumn[] = [
      { id: 'feature', name: 'Feature', type: 'text' },
      { id: 'a', name: 'A', type: 'text' },
      { id: 'b', name: 'B', type: 'text' },
    ];
    const rows = [
      { feature: 'Notes', a: '1', b: '2' },
      { feature: 'notes', a: '3', b: '4' },
    ];
    const result = transposeTable(columns, rows, 'Name');
    expect(result.columns.map((c) => c.name)).toEqual([
      'Name',
      'Notes',
      'notes (2)',
    ]);
    expect(result.rows[0][result.columns[1].id]).toBe(1);
    expect(result.rows[0][result.columns[2].id]).toBe(3);
  });

  it('never leaks row ids into the transposed table', () => {
    const rows = matrixRows.map((row, i) => ({
      ...row,
      [ROW_ID_KEY]: String(i),
    }));
    const result = transposeTable(matrixColumns, rows, 'Name');
    expect(result.columns.some((c) => c.id === ROW_ID_KEY)).toBe(false);
    for (const row of result.rows) {
      expect(ROW_ID_KEY in row).toBe(false);
    }
  });
});
