import {
  columnsToRowSchema,
  extractionResponseSchema,
} from '@/lib/services/workflows/data/tableSchema';

import { DataColumn } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const column = (id: string, overrides: Partial<DataColumn> = {}): DataColumn =>
  ({
    id,
    name: id,
    type: 'text',
    ...overrides,
  }) as DataColumn;

describe('columnsToRowSchema', () => {
  it('keys row properties by column id with per-type value schemas', () => {
    const schema = columnsToRowSchema([
      column('title'),
      column('count', { type: 'number' }),
    ]) as {
      properties: Record<string, { type: string[] }>;
      required: string[];
    };

    expect(Object.keys(schema.properties)).toEqual(['title', 'count']);
    expect(schema.properties.count.type).toEqual(['number', 'null']);
    expect(schema.required).toEqual(['title', 'count']);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the prototype-polluting column id %s',
    (id) => {
      expect(() => columnsToRowSchema([column(id)])).toThrow(
        'Invalid column id',
      );
      // And the object must not have been polluted before the throw.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );
});

describe('extractionResponseSchema', () => {
  it('wraps the row schema in a strict rows array', () => {
    const schema = extractionResponseSchema([column('title')]) as {
      properties: { rows: { items: { properties: object } } };
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties.rows.items.properties)).toEqual([
      'title',
    ]);
    expect(schema.additionalProperties).toBe(false);
  });
});
