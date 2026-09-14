import {
  buildFillSchema,
  normalizeFillResponse,
} from '@/lib/services/workflows/form/fillSchema';

import { FormField } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

const fields: FormField[] = [
  { id: 'title', sectionId: 's', label: 'Title', type: 'text', required: true },
  {
    id: 'budget',
    sectionId: 's',
    label: 'Budget',
    type: 'number',
    required: false,
  },
  {
    id: 'region',
    sectionId: 's',
    label: 'Region',
    type: 'enum',
    required: false,
    validation: { enumValues: ['North', 'South'] },
  },
  {
    id: 'goals',
    sectionId: 's',
    label: 'Goals',
    type: 'list<text>',
    required: false,
  },
];

describe('buildFillSchema', () => {
  it('lists every target as a required nullable property', () => {
    const schema = buildFillSchema(fields, 'targeted') as {
      properties: {
        fields: { required: string[]; properties: Record<string, unknown> };
      };
    };
    expect(schema.properties.fields.required).toEqual([
      'title',
      'budget',
      'region',
      'goals',
    ]);
    const region = schema.properties.fields.properties.region as {
      properties: { value: { enum: unknown[] } };
    };
    expect(region.properties.value.enum).toEqual(['North', 'South', null]);
  });

  it('rejects prototype-polluting ids', () => {
    expect(() =>
      buildFillSchema(
        [{ ...fields[0], id: '__proto__' as string }],
        'targeted',
      ),
    ).toThrow();
  });
});

describe('normalizeFillResponse', () => {
  const known = new Set(['src1']);

  it('coerces values per type and drops fabricated citations', () => {
    const { proposals } = normalizeFillResponse(
      {
        fields: {
          title: {
            value: '  Water project  ',
            confidence: 'high',
            gaps: '',
            generalKnowledge: false,
            provenance: [
              { sourceId: 'src1', excerpt: 'Water project in Goma' },
              { sourceId: 'made-up', excerpt: 'x' },
            ],
          },
          budget: {
            value: '12000',
            confidence: 'medium',
            gaps: 'currency unstated',
            generalKnowledge: false,
            provenance: [],
          },
          goals: {
            value: ['a', '', ' b '],
            confidence: 'weird',
            gaps: '',
            generalKnowledge: false,
            provenance: [],
          },
        },
        questions: [],
      },
      fields,
      known,
    );
    const byId = Object.fromEntries(proposals.map((p) => [p.fieldId, p]));
    expect(byId.title.value).toBe('Water project');
    expect(byId.title.provenance).toEqual([
      { sourceId: 'src1', excerpt: 'Water project in Goma' },
    ]);
    // A string where a number was required is not a number: null + gaps kept.
    expect(byId.budget.value).toBeNull();
    expect(byId.budget.gaps).toBe('currency unstated');
    expect(byId.goals.value).toEqual(['a', 'b']);
    expect(byId.goals.confidence).toBe('low');
  });

  it('drops null values without gaps and unknown fields', () => {
    const { proposals } = normalizeFillResponse(
      {
        fields: {
          title: {
            value: null,
            confidence: 'low',
            gaps: '',
            generalKnowledge: false,
            provenance: [],
          },
          ghost: {
            value: 'x',
            confidence: 'high',
            gaps: '',
            generalKnowledge: false,
            provenance: [],
          },
        },
        questions: [],
      },
      fields,
      known,
    );
    expect(proposals).toEqual([]);
  });

  it('keeps at most three questions and only known field ids', () => {
    const { questions } = normalizeFillResponse(
      {
        fields: {},
        questions: [
          { text: 'q1', fieldIds: ['title', 'nope'] },
          { text: ' ', fieldIds: [] },
          { text: 'q2', fieldIds: [] },
          { text: 'q3', fieldIds: [] },
          { text: 'q4', fieldIds: [] },
        ],
      },
      fields,
      known,
    );
    expect(questions.map((q) => q.text)).toEqual(['q1', 'q2', 'q3']);
    expect(questions[0].fieldIds).toEqual(['title']);
  });
});
