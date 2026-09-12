import { ROW_ID_KEY } from '@/lib/services/workflows/data/tableUtils';
import { Clock } from '@/lib/services/workflows/form/ledger';
import {
  documentsFromRows,
  matchColumnsToFields,
  tableFromDocuments,
} from '@/lib/services/workflows/form/records';
import { fieldStatus } from '@/lib/services/workflows/form/status';

import { FormFillWorkflowState, FormTemplate } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

let n = 0;
const clock: Clock = { now: () => 'now', mintId: () => `id-${++n}` };

const template: FormTemplate = {
  id: 't',
  name: 'Project sheet',
  sections: [{ id: 's', heading: 'S' }],
  fields: [
    {
      id: 'title',
      sectionId: 's',
      label: 'Project title',
      type: 'text',
      required: true,
    },
    {
      id: 'budget',
      sectionId: 's',
      label: 'Budget (EUR)',
      type: 'number',
      required: false,
    },
    {
      id: 'start',
      sectionId: 's',
      label: 'Start date',
      type: 'date',
      required: false,
    },
    {
      id: 'goals',
      sectionId: 's',
      label: 'Goals',
      type: 'list<text>',
      required: false,
    },
    {
      id: 'approved',
      sectionId: 's',
      label: 'Approved',
      type: 'boolean',
      required: false,
    },
  ],
  layout: '',
  origin: 'user',
  createdAt: '',
  updatedAt: '',
};

const empty: FormFillWorkflowState = {
  kind: 'form-fill',
  documents: [],
  sources: [],
  notes: [],
  updatedAt: '',
};

describe('matchColumnsToFields', () => {
  it('matches by id, then normalized label, never twice', () => {
    const mapping = matchColumnsToFields(
      [
        { id: 'title', name: 'whatever', type: 'text' },
        { id: 'c2', name: 'Budget (EUR)', type: 'number' },
        { id: 'c3', name: 'budget eur', type: 'text' },
        { id: 'c4', name: 'Unrelated', type: 'text' },
      ],
      template,
    );
    expect([...mapping.entries()]).toEqual([
      ['title', 'title'],
      ['c2', 'budget'],
    ]);
  });
});

describe('documentsFromRows', () => {
  it('creates one confirmed-prefilled document per row and respects the cap', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      title: `Project ${i}`,
      c2: i === 0 ? '12,000' : 5,
      start: '2026-01-01',
      approved: 'yes',
      goals: 'a\nb',
    }));
    const result = documentsFromRows(
      empty,
      template,
      {
        columns: [
          { id: 'title', name: 'Project title', type: 'text' },
          { id: 'c2', name: 'Budget (EUR)', type: 'number' },
          { id: 'start', name: 'Start date', type: 'date' },
          { id: 'approved', name: 'Approved', type: 'boolean' },
          { id: 'goals', name: 'Goals', type: 'text' },
        ],
        rows,
      },
      { clock },
    );
    expect(result.created).toBe(10);
    expect(result.skipped).toBe(2);
    expect(result.matchedFieldIds.sort()).toEqual([
      'approved',
      'budget',
      'goals',
      'start',
      'title',
    ]);
    const first = result.state.documents[0];
    expect(first.fields.title).toMatchObject({
      value: 'Project 0',
      decision: 'confirmed',
    });
    expect(first.fields.budget.value).toBe(12000);
    expect(first.fields.approved.value).toBe(true);
    expect(first.fields.goals.value).toEqual(['a', 'b']);
    expect(fieldStatus(template.fields[0], first.fields.title).status).toBe(
      'confirmed',
    );
    expect(result.state.activeDocumentId).toBe(result.state.documents[9].id);
  });

  it('imports invalid cells without confirming them', () => {
    const result = documentsFromRows(
      empty,
      template,
      {
        columns: [{ id: 'start', name: 'Start date', type: 'text' }],
        rows: [{ start: '03/01/2024' }],
      },
      { clock },
    );
    const fill = result.state.documents[0].fields.start;
    expect(fill.value).toBe('03/01/2024');
    expect(fill.decision).toBeUndefined();
    expect(fieldStatus(template.fields[2], fill).status).toBe('partial');
  });

  it('leaves blank cells empty', () => {
    const result = documentsFromRows(
      empty,
      template,
      {
        columns: [{ id: 'title', name: 'Project title', type: 'text' }],
        rows: [{ title: '  ' }],
      },
      { clock },
    );
    expect(result.created).toBe(1);
    expect(result.state.documents[0].fields.title).toBeUndefined();
  });
});

describe('tableFromDocuments', () => {
  it('builds a union of columns and one typed row per document with rids', () => {
    const state = documentsFromRows(
      empty,
      template,
      {
        columns: [
          { id: 'title', name: 'Project title', type: 'text' },
          { id: 'c2', name: 'Budget (EUR)', type: 'number' },
          { id: 'goals', name: 'Goals', type: 'text' },
        ],
        rows: [
          { title: 'A', c2: 10, goals: 'x\ny' },
          { title: 'B', c2: null, goals: null },
        ],
      },
      { clock },
    ).state;
    const table = tableFromDocuments(state.documents);
    expect(table.columns.map((c) => [c.id, c.type])).toEqual([
      ['document_name', 'text'],
      ['title', 'text'],
      ['budget', 'number'],
      ['start', 'date'],
      ['goals', 'text'],
      ['approved', 'boolean'],
    ]);
    expect(table.columns[1].required).toBe(true);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]).toMatchObject({
      document_name: 'Project sheet',
      title: 'A',
      budget: 10,
      goals: 'x; y',
      start: null,
      approved: null,
    });
    expect(table.rows[0][ROW_ID_KEY]).toBe('0');
    expect(table.rows[1][ROW_ID_KEY]).toBe('1');
    expect(table.nextRowId).toBe(2);
  });
});
