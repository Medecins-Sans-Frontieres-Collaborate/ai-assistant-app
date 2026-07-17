import {
  datasetToCsv,
  datasetToJson,
  datasetToTsv,
  exportDataset,
  extensionFor,
  filenameStemFor,
  mimeTypeFor,
} from '@/lib/utils/shared/chat/extractionExport';

import { ExtractionDataset } from '@/types/chat';

import { describe, expect, it } from 'vitest';

function makeDataset(
  overrides: Partial<ExtractionDataset> = {},
): ExtractionDataset {
  return {
    recipeId: 'patients',
    recipeName: 'Patients',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'age', type: 'number' },
      { name: 'diagnoses', type: 'list<text>' },
    ],
    rows: [
      { name: 'Alice', age: 42, diagnoses: ['malaria', 'anaemia'] },
      { name: 'Bob, Jr.', age: 31, diagnoses: [] },
    ],
    ...overrides,
  };
}

describe('extractionExport - extensions and MIME types', () => {
  it('maps each format to its expected extension', () => {
    expect(extensionFor('json')).toBe('json');
    expect(extensionFor('csv')).toBe('csv');
    expect(extensionFor('tsv')).toBe('tsv');
  });

  it('maps each format to a UTF-8 MIME type', () => {
    expect(mimeTypeFor('json')).toMatch(/^application\/json/);
    expect(mimeTypeFor('csv')).toMatch(/^text\/csv/);
    expect(mimeTypeFor('tsv')).toMatch(/^text\/tab-separated-values/);
  });
});

describe('extractionExport - filenameStemFor', () => {
  it('slugifies the recipe name into snake_case', () => {
    expect(filenameStemFor(makeDataset({ recipeName: 'Patient List' }))).toBe(
      'patient_list',
    );
  });

  it('falls back to "extraction" for empty / whitespace names', () => {
    expect(filenameStemFor(makeDataset({ recipeName: '' }))).toBe('extraction');
    expect(filenameStemFor(makeDataset({ recipeName: '   ' }))).toBe(
      'extraction',
    );
    expect(filenameStemFor(makeDataset({ recipeName: '###' }))).toBe(
      'extraction',
    );
  });
});

describe('extractionExport - datasetToJson', () => {
  it('emits an indented JSON array of row objects', () => {
    const json = datasetToJson(makeDataset());
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([
      { name: 'Alice', age: 42, diagnoses: ['malaria', 'anaemia'] },
      { name: 'Bob, Jr.', age: 31, diagnoses: [] },
    ]);
    expect(json).toContain('\n  ');
  });
});

describe('extractionExport - datasetToCsv', () => {
  it('renders a header from field names', () => {
    const csv = datasetToCsv(makeDataset());
    const header = csv.split('\n')[0];
    expect(header).toBe('name,age,diagnoses');
  });

  it('prefers field label over name in the header when set', () => {
    const dataset = makeDataset({
      fields: [{ name: 'name', label: 'Full name', type: 'text' }],
      rows: [{ name: 'Alice' }],
    });
    expect(datasetToCsv(dataset).split('\n')[0]).toBe('Full name');
  });

  it('quotes cells that contain a comma', () => {
    const csv = datasetToCsv(makeDataset());
    const bobLine = csv.split('\n')[2];
    expect(bobLine).toContain('"Bob, Jr."');
  });

  it('escapes embedded double-quotes by doubling them (RFC 4180)', () => {
    const dataset = makeDataset({
      rows: [{ name: 'She said "hi"', age: 1, diagnoses: [] }],
    });
    const line = datasetToCsv(dataset).split('\n')[1];
    expect(line).toBe('"She said ""hi""",1,');
  });

  it('quotes cells with newlines and preserves the newline', () => {
    const dataset = makeDataset({
      rows: [{ name: 'multi\nline', age: 1, diagnoses: [] }],
    });
    const csv = datasetToCsv(dataset);
    expect(csv).toContain('"multi\nline"');
  });

  it('renders missing / null cell values as empty strings', () => {
    const dataset = makeDataset({
      rows: [{ name: 'Alice', age: null, diagnoses: undefined }],
    });
    expect(datasetToCsv(dataset).split('\n')[1]).toBe('Alice,,');
  });

  it('joins list<text> values with "; " in a single cell', () => {
    const csv = datasetToCsv(makeDataset());
    expect(csv.split('\n')[1]).toBe('Alice,42,malaria; anaemia');
  });

  it('stringifies nested-object cell values rather than dropping them', () => {
    const dataset = makeDataset({
      fields: [{ name: 'meta', type: 'text' }],
      rows: [{ meta: { foo: 'bar' } }],
    });
    const line = datasetToCsv(dataset).split('\n')[1];
    expect(line).toBe('"{""foo"":""bar""}"');
  });
});

describe('extractionExport - datasetToTsv', () => {
  it('uses tab separators', () => {
    const tsv = datasetToTsv(makeDataset());
    expect(tsv.split('\n')[0]).toBe('name\tage\tdiagnoses');
    expect(tsv.split('\n')[1]).toBe('Alice\t42\tmalaria; anaemia');
  });

  it('does not RFC-quote commas in TSV', () => {
    const tsv = datasetToTsv(makeDataset());
    expect(tsv).toContain('Bob, Jr.');
    expect(tsv).not.toContain('"Bob, Jr."');
  });

  it('replaces internal tabs and newlines with single spaces', () => {
    const dataset = makeDataset({
      rows: [{ name: 'col1\tcol2', age: 1, diagnoses: [] }],
    });
    expect(datasetToTsv(dataset).split('\n')[1]).toBe('col1 col2\t1\t');
  });
});

describe('extractionExport - exportDataset', () => {
  it('combines content, mime, and filename for the chosen format', () => {
    const result = exportDataset(makeDataset(), 'csv');
    expect(result.filename).toBe('patients.csv');
    expect(result.mimeType).toMatch(/^text\/csv/);
    expect(result.content.split('\n')[0]).toBe('name,age,diagnoses');
  });
});
