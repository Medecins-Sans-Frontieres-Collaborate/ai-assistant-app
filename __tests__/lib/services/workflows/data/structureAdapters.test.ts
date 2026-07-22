import {
  columnsToStructure,
  structureToColumns,
} from '@/lib/services/workflows/data/structureAdapters';
import { MAX_COLUMNS } from '@/lib/services/workflows/data/tableUtils';

import { SavedStructure, StructureField } from '@/types/structure';
import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const NOW = '2026-07-19T00:00:00.000Z';

const field = (
  name: string,
  overrides: Partial<StructureField> = {},
): StructureField => ({ id: name, name, type: 'text', ...overrides });

const structure = (fields: StructureField[]): SavedStructure => ({
  id: 's1',
  name: 'Invoices',
  fields,
  createdAt: NOW,
  updatedAt: NOW,
});

const column = (
  id: string,
  overrides: Partial<DataColumn> = {},
): DataColumn => ({
  id,
  name: id,
  type: 'text',
  ...overrides,
});

describe('structureToColumns', () => {
  it('carries tabular fields across unchanged', () => {
    const { columns, downgraded } = structureToColumns(
      structure([
        field('title'),
        field('total', { type: 'number' }),
        field('due', { type: 'date' }),
        field('paid', { type: 'boolean' }),
      ]),
    );

    expect(columns.map((c) => [c.id, c.type])).toEqual([
      ['title', 'text'],
      ['total', 'number'],
      ['due', 'date'],
      ['paid', 'boolean'],
    ]);
    expect(downgraded).toEqual([]);
  });

  it('downgrades enum and list fields to text and reports them', () => {
    const { columns, downgraded } = structureToColumns(
      structure([
        field('status', { type: 'enum', enumValues: ['open', 'closed'] }),
        field('tags', { type: 'list<text>' }),
        field('scores', { type: 'list<number>' }),
        field('title'),
      ]),
    );

    expect(columns.map((c) => c.type)).toEqual([
      'text',
      'text',
      'text',
      'text',
    ]);
    expect(downgraded).toEqual(['status', 'tags', 'scores']);
  });

  it('preserves required only when explicitly set', () => {
    const { columns } = structureToColumns(
      structure([
        field('a', { required: true }),
        field('b', { required: false }),
        field('c'),
      ]),
    );

    expect(columns[0].required).toBe(true);
    expect(columns[1].required).toBeUndefined();
    expect(columns[2].required).toBeUndefined();
  });

  it('slugs names into ids and suffixes collisions', () => {
    const { columns } = structureToColumns(
      structure([field('Total (USD)'), field('total_usd'), field('Total USD')]),
    );

    expect(columns.map((c) => c.id)).toEqual([
      'total_usd',
      'total_usd_2',
      'total_usd_3',
    ]);
  });

  it('prefers the label as the column display name', () => {
    const { columns } = structureToColumns(
      structure([field('total_usd', { label: 'Total (USD)' })]),
    );

    expect(columns[0]).toMatchObject({ id: 'total_usd', name: 'Total (USD)' });
  });

  it('truncates past MAX_COLUMNS and reports the dropped names', () => {
    const fields = Array.from({ length: MAX_COLUMNS + 3 }, (_, i) =>
      field(`f${i}`),
    );
    const { columns, truncated } = structureToColumns(structure(fields));

    expect(columns).toHaveLength(MAX_COLUMNS);
    expect(truncated).toEqual([
      `f${MAX_COLUMNS}`,
      `f${MAX_COLUMNS + 1}`,
      `f${MAX_COLUMNS + 2}`,
    ]);
  });
});

describe('columnsToStructure', () => {
  const meta = { id: 's-new', name: 'From table', now: NOW };

  it('maps columns to fields, keeping the display name as label', () => {
    const { structure: out, skipped } = columnsToStructure(
      [
        column('title', { name: 'Title' }),
        column('total', { name: 'total', type: 'number', required: true }),
      ],
      meta,
    );

    expect(out.fields).toEqual([
      { id: 'title', name: 'title', label: 'Title', type: 'text' },
      { id: 'total', name: 'total', type: 'number', required: true },
    ]);
    expect(skipped).toEqual([]);
    expect(out).toMatchObject({
      id: 's-new',
      name: 'From table',
      createdAt: NOW,
    });
  });

  it('skips derived columns and reports them', () => {
    const { structure: out, skipped } = columnsToStructure(
      [
        column('cases', { type: 'number' }),
        column('population', { type: 'number' }),
        column('rate', {
          name: 'Rate',
          type: 'number',
          formula: '[cases] / [population] * 1000',
        }),
      ],
      meta,
    );

    expect(out.fields.map((f) => f.id)).toEqual(['cases', 'population']);
    expect(skipped).toEqual(['Rate']);
  });

  it('drops display-only number formatting', () => {
    const { structure: out } = columnsToStructure(
      [
        column('total', {
          type: 'number',
          format: { currency: '$', numberStyle: 'us' },
        }),
      ],
      meta,
    );

    expect(out.fields[0]).not.toHaveProperty('format');
  });

  it('round-trips a tabular structure without loss', () => {
    const original = structure([
      field('title', { required: true }),
      field('total', { type: 'number' }),
      field('due', { type: 'date' }),
    ]);

    const { columns } = structureToColumns(original);
    const { structure: out } = columnsToStructure(columns, meta);

    expect(
      out.fields.map((f) => [f.name, f.type, f.required ?? false]),
    ).toEqual(
      original.fields.map((f) => [f.name, f.type, f.required ?? false]),
    );
  });
});
