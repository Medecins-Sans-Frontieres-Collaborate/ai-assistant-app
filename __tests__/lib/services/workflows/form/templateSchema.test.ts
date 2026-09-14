import { parseTemplate } from '@/lib/services/workflows/form/templateSchema';

import { describe, expect, it } from 'vitest';

const valid = {
  id: 't',
  name: 'T',
  sections: [{ id: 's', heading: 'S' }],
  fields: [
    { id: 'a', sectionId: 's', label: 'A', type: 'text', required: true },
    {
      id: 'b',
      sectionId: 's',
      label: 'B',
      type: 'enum',
      required: false,
      validation: { enumValues: ['x', 'y'] },
      anchor: { kind: 'docx-control', tag: 'b' },
    },
  ],
  layout: '{{field:a}} {{field:b}}',
  origin: 'user',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('parseTemplate', () => {
  it('accepts a well-formed template', () => {
    const result = parseTemplate(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects duplicate ids, unknown sections, bad ids and unknown keys', () => {
    const dup = parseTemplate({
      ...valid,
      fields: [valid.fields[0], valid.fields[0]],
    });
    expect(dup).toMatchObject({
      ok: false,
      error: expect.stringContaining('Duplicate'),
    });
    const ghost = parseTemplate({
      ...valid,
      fields: [{ ...valid.fields[0], sectionId: 'nope' }],
    });
    expect(ghost).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown section'),
    });
    const proto = parseTemplate({
      ...valid,
      fields: [{ ...valid.fields[0], id: '__proto__' }],
    });
    expect(proto.ok).toBe(false);
    const upper = parseTemplate({
      ...valid,
      fields: [{ ...valid.fields[0], id: 'Bad-Id' }],
    });
    expect(upper.ok).toBe(false);
    const extra = parseTemplate({
      ...valid,
      fields: [{ ...valid.fields[0], surprise: 1 }],
    });
    expect(extra.ok).toBe(false);
  });

  it('rejects an empty field list', () => {
    expect(parseTemplate({ ...valid, fields: [] }).ok).toBe(false);
  });
});
