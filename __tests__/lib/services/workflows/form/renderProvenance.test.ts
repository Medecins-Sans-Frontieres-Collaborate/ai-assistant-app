import {
  ProvenanceStrings,
  buildProvenanceJson,
  buildProvenanceMarkdown,
} from '@/lib/services/workflows/form/provenance';
import {
  exportBaseName,
  renderLayout,
  valuesForFill,
} from '@/lib/services/workflows/form/render';

import { FormDocument } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

const document: FormDocument = {
  id: 'd',
  language: 'English',
  template: {
    id: 't',
    name: 'Proposal',
    sections: [{ id: 's', heading: 'Main' }],
    fields: [
      {
        id: 'title',
        sectionId: 's',
        label: 'Title',
        type: 'text',
        required: true,
      },
      {
        id: 'goals',
        sectionId: 's',
        label: 'Goals',
        type: 'list<text>',
        required: false,
      },
      {
        id: 'ok',
        sectionId: 's',
        label: 'Approved',
        type: 'boolean',
        required: false,
      },
      {
        id: 'na',
        sectionId: 's',
        label: 'Annex',
        type: 'text',
        required: false,
      },
      {
        id: 'missing',
        sectionId: 's',
        label: 'Missing',
        type: 'text',
        required: false,
      },
    ],
    layout:
      '# {{field:title}}\n\nGoals:\n\n{{field:goals}}\n\nApproved: {{field:ok}} · Annex: {{field:na}} · {{field:missing}} · {{field:unknown}}',
    origin: 'user',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  fields: {
    title: {
      value: 'Water',
      provenance: [{ sourceId: 'src', excerpt: 'water for all' }],
      confidence: 'high',
      updatedAt: '',
    },
    goals: { value: ['a', 'b'], provenance: [], updatedAt: '' },
    ok: { value: true, provenance: [], generalKnowledge: true, updatedAt: '' },
    na: {
      value: null,
      decision: 'not_applicable',
      provenance: [],
      updatedAt: '',
    },
  },
  questions: [
    {
      id: 'q',
      mode: 'targeted',
      text: 'Where?',
      fieldIds: ['missing'],
      status: 'open',
      askedAt: '',
    },
  ],
  runs: [
    {
      id: 'r',
      at: '2026-01-02T00:00:00Z',
      modelId: 'gpt',
      fieldIds: ['title'],
      sourceIds: ['src'],
      proposedFieldIds: ['title'],
    },
  ],
  proposals: [],
};

describe('renderLayout', () => {
  it('substitutes values by type, keeps unknown slots, styles via wrap', () => {
    const out = renderLayout(document);
    expect(out).toContain('# Water');
    expect(out).toContain('- a\n- b');
    const inline = renderLayout({
      ...document,
      template: { ...document.template, layout: 'Goals: {{field:goals}}' },
    });
    expect(inline).toBe('Goals: a; b');
    expect(out).toContain('Approved: Yes');
    expect(out).toContain('Annex: N/A');
    expect(out).toContain('[Missing]');
    expect(out).toContain('{{field:unknown}}');
    expect(renderLayout(document, { emptyAs: 'blank' })).not.toContain(
      '[Missing]',
    );
    const wrapped = renderLayout(document, {
      wrap: (field, text, status) => `<${status}:${field.id}>${text}`,
    });
    expect(wrapped).toContain('<filled:title>Water');
    expect(wrapped).toContain('<partial:goals>');
  });

  it('valuesForFill flattens for the in-place fillers', () => {
    expect(valuesForFill(document)).toEqual({
      title: 'Water',
      goals: 'a\nb',
      ok: 'Yes',
      na: 'N/A',
    });
  });

  it('exportBaseName strips path-hostile characters', () => {
    expect(exportBaseName(' Grant: 2026/Q3 <draft> ')).toBe(
      'Grant 2026Q3 draft',
    );
    expect(exportBaseName('   ')).toBe('form');
  });
});

const strings: ProvenanceStrings = {
  title: 'Provenance',
  generatedAt: 'Generated',
  template: 'Template',
  language: 'Language',
  runs: 'Runs',
  runLine: (at, model, fields, sources) =>
    `${at} ${model} ${fields} ${sources}`,
  sources: 'Sources',
  noSources: 'No sources',
  sourceLine: (s) => `${s.kind}: ${s.name}`,
  fields: 'Fields',
  status: {
    label: 'Status',
    empty: 'Empty',
    partial: 'Partial',
    filled: 'Filled',
    confirmed: 'Confirmed',
    not_applicable: 'N/A',
  },
  confidence: 'Confidence',
  issues: 'Issues',
  issueText: (i) => i.code,
  gaps: 'Gaps',
  supportedBy: 'Supported by',
  unsourced: 'UNSOURCED',
  generalKnowledge: 'GENERAL',
  lockedByAdmin: 'LOCKED',
  fromNote: 'Note',
  openQuestions: 'Open questions',
  noOpenQuestions: 'None',
  notApplicableFields: 'N/A fields',
  none: 'None',
  value: 'Value',
  empty: 'empty',
};

describe('provenance document', () => {
  const sources = [
    {
      id: 'src',
      kind: 'file' as const,
      name: 'report.pdf',
      chars: 10,
      addedAt: '',
    },
  ];

  it('sources every claim and lists what is open', () => {
    const md = buildProvenanceMarkdown({
      document,
      sources,
      notes: [],
      strings,
      now: new Date('2026-01-03T00:00:00Z'),
    });
    expect(md).toContain('# Provenance: Proposal');
    expect(md).toContain('- file: report.pdf');
    expect(md).toContain('report.pdf: "water for all"');
    expect(md).toContain('- UNSOURCED'); // goals
    expect(md).toContain('- GENERAL'); // ok
    expect(md).toContain('- Where?');
    expect(md).toContain('- Annex'); // N/A list
    expect(md).toContain('2026-01-02T00:00:00Z gpt 1 1');
  });

  it('json twin carries statuses and issues', () => {
    const json = buildProvenanceJson({ document, sources, notes: [] }) as {
      fields: Array<{ id: string; status: string; issues: unknown[] }>;
    };
    const byId = Object.fromEntries(json.fields.map((f) => [f.id, f]));
    expect(byId.title.status).toBe('filled');
    expect(byId.goals.status).toBe('partial');
    expect(byId.na.status).toBe('not_applicable');
    expect(byId.missing.status).toBe('empty');
  });
});
