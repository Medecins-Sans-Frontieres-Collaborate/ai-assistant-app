import {
  RawDerivedTemplate,
  buildTemplateDraft,
  layoutFromStructure,
  layoutSlotIds,
  normalizeDerived,
  reconcileLayout,
  slugify,
} from '@/lib/services/workflows/form/deriveSchema';

import { describe, expect, it } from 'vitest';

const rawField = (
  overrides: Partial<RawDerivedTemplate['fields'][number]>,
): RawDerivedTemplate['fields'][number] => ({
  key: '',
  sectionKey: 'main',
  label: 'Field',
  type: 'text',
  description: '',
  required: false,
  enumValues: [],
  minWords: null,
  maxWords: null,
  maxChars: null,
  minItems: null,
  rubric: '',
  example: '',
  ...overrides,
});

describe('slugify', () => {
  it('produces safe field ids', () => {
    expect(slugify('Project Title (EN)', 'x')).toBe('project_title_en');
    expect(slugify('Résumé du projet', 'x')).toBe('resume_du_projet');
    expect(slugify('123', 'fallback')).toBe('fallback');
    expect(slugify('', 'fallback')).toBe('fallback');
  });
});

describe('normalizeDerived', () => {
  it('mints unique ids, repairs sections, maps validation', () => {
    const draft = normalizeDerived({
      name: ' Grant form ',
      description: '',
      language: 'French',
      sections: [
        { key: 'main', heading: 'Main', guidance: '' },
        { key: 'unused', heading: 'Unused', guidance: '' },
      ],
      fields: [
        rawField({
          key: 'title',
          label: 'Title',
          required: true,
          maxChars: 80,
        }),
        rawField({ key: 'title', label: 'Title again' }),
        rawField({
          label: 'Country',
          type: 'text',
          enumValues: ['DRC', 'CAR'],
          sectionKey: 'ghost',
        }),
        rawField({
          label: 'Narrative',
          type: 'longtext',
          minWords: 100,
          maxWords: 50,
          rubric: 'must cite a baseline',
        }),
        rawField({ label: '', type: 'text' }),
        rawField({ label: 'Weird', type: 'blob' }),
      ],
    });
    expect(draft.name).toBe('Grant form');
    expect(draft.language).toBe('French');
    expect(draft.fields.map((f) => f.id)).toEqual([
      'title',
      'title_2',
      'country',
      'narrative',
      'weird',
    ]);
    expect(draft.fields[0]).toMatchObject({
      required: true,
      validation: { maxChars: 80 },
    });
    // enum options promote a text field to enum
    expect(draft.fields[2]).toMatchObject({
      type: 'enum',
      sectionId: 'other',
      validation: { enumValues: ['DRC', 'CAR'] },
    });
    // maxWords below minWords is dropped; rubric kept
    expect(draft.fields[3].validation).toEqual({
      minWords: 100,
      rubric: 'must cite a baseline',
    });
    expect(draft.fields[4].type).toBe('text');
    // unused section dropped, "Other" minted for the orphan
    expect(draft.sections.map((s) => s.id)).toEqual(['main', 'other']);
  });
});

describe('layouts', () => {
  const draft = {
    name: 'Form',
    sections: [{ id: 's', heading: 'Section' }],
    fields: [
      {
        id: 'a',
        sectionId: 's',
        label: 'A',
        type: 'text' as const,
        required: false,
      },
      {
        id: 'b',
        sectionId: 's',
        label: 'B',
        type: 'longtext' as const,
        required: false,
      },
    ],
  };

  it('structural layout places every field once', () => {
    const layout = layoutFromStructure(draft);
    expect(layoutSlotIds(layout)).toEqual(['a', 'b']);
    expect(layout).toContain('**A:** {{field:a}}');
    expect(layout).toContain('### B');
  });

  it('accepts a complete model layout and appends missing slots', () => {
    expect(reconcileLayout('# X\n{{field:a}} {{field:b}}', draft)).toBe(
      '# X\n{{field:a}} {{field:b}}\n',
    );
    const patched = reconcileLayout('# X\n\n{{field:a}}\n', draft);
    expect(layoutSlotIds(patched)).toEqual(['a', 'b']);
  });

  it('falls back when the model invents slots or misses most fields', () => {
    expect(reconcileLayout('{{field:zzz}}', draft)).toBe(
      layoutFromStructure(draft),
    );
    const many = {
      ...draft,
      fields: [
        ...draft.fields,
        {
          id: 'c',
          sectionId: 's',
          label: 'C',
          type: 'text' as const,
          required: false,
        },
      ],
    };
    expect(reconcileLayout('nothing here', many)).toBe(
      layoutFromStructure(many),
    );
  });

  it('buildTemplateDraft threads the original through', () => {
    const template = buildTemplateDraft(
      { ...draft, description: undefined, language: undefined },
      {
        original: {
          fileId: '/api/file/x.docx',
          name: 'x.docx',
          mime: 'docx',
          fillMode: 'none',
        },
      },
    );
    expect(template.original?.mime).toBe('docx');
    expect(layoutSlotIds(template.layout)).toEqual(['a', 'b']);
  });
});
