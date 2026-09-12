import {
  anchorDocxFields,
  anchorPdfFields,
} from '@/lib/services/workflows/form/anchors';
import { DocxControl } from '@/lib/services/workflows/form/docxFill';

import { FormField } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

const fields: FormField[] = [
  {
    id: 'project_title',
    sectionId: 's',
    label: 'Project title',
    type: 'text',
    required: true,
  },
  {
    id: 'summary',
    sectionId: 's',
    label: 'Summary',
    type: 'longtext',
    required: false,
  },
  {
    id: 'agree',
    sectionId: 's',
    label: 'I agree to the terms',
    type: 'boolean',
    required: false,
  },
  {
    id: 'region',
    sectionId: 's',
    label: 'Region',
    type: 'text',
    required: false,
  },
  {
    id: 'orphan',
    sectionId: 's',
    label: 'Something else',
    type: 'text',
    required: false,
  },
];

const control = (
  key: string,
  kind: DocxControl['kind'],
  extra: Partial<DocxControl> = {},
): DocxControl => ({
  key,
  kind,
  text: '',
  part: 'word/document.xml',
  ...extra,
});

describe('anchorDocxFields', () => {
  it('matches by tag, alias and placeholder text; respects kinds; reports leftovers', () => {
    const { fields: anchored, report } = anchorDocxFields(fields, [
      control('title_ctrl', 'text', { alias: 'Project Title' }),
      control('summary', 'text', { tag: 'summary' }),
      control('terms', 'checkbox', {
        tag: 'terms',
        text: 'I agree to the terms',
      }),
      control('Region', 'dropdown', {
        alias: 'Region',
        options: ['North', 'South'],
      }),
      control('signature', 'text', { alias: 'Signature' }),
    ]);
    const byId = Object.fromEntries(anchored.map((f) => [f.id, f]));
    expect(byId.project_title.anchor).toEqual({
      kind: 'docx-control',
      tag: 'title_ctrl',
    });
    expect(byId.summary.anchor).toEqual({
      kind: 'docx-control',
      tag: 'summary',
    });
    expect(byId.agree.anchor).toEqual({ kind: 'docx-control', tag: 'terms' });
    expect(byId.region).toMatchObject({
      type: 'enum',
      anchor: { kind: 'docx-control', tag: 'Region' },
      validation: { enumValues: ['North', 'South'] },
    });
    expect(byId.orphan.anchor).toBeUndefined();
    expect(report).toEqual({
      fillMode: 'docx-controls',
      unmatchedSlots: ['signature'],
      unanchoredFieldIds: ['orphan'],
      anchoredCount: 4,
    });
  });

  it('a checkbox never anchors a text field and vice versa', () => {
    const { fields: anchored } = anchorDocxFields(fields, [
      control('project_title', 'checkbox', { tag: 'project_title' }),
    ]);
    expect(
      anchored.find((f) => f.id === 'project_title')?.anchor,
    ).toBeUndefined();
  });

  it('reports none when the original has no controls', () => {
    const { report } = anchorDocxFields(fields, []);
    expect(report.fillMode).toBe('none');
    expect(report.unanchoredFieldIds).toHaveLength(fields.length);
  });
});

describe('anchorPdfFields', () => {
  it('matches on the last name segment of XFA-style names', () => {
    const { fields: anchored, report } = anchorPdfFields(fields, [
      { name: 'topmostSubform[0].Page1[0].Project_Title[0]', kind: 'text' },
      { name: 'agree', kind: 'checkbox' },
      { name: 'sig', kind: 'other' },
    ]);
    expect(anchored.find((f) => f.id === 'project_title')?.anchor).toEqual({
      kind: 'pdf-field',
      fieldName: 'topmostSubform[0].Page1[0].Project_Title[0]',
    });
    expect(anchored.find((f) => f.id === 'agree')?.anchor).toEqual({
      kind: 'pdf-field',
      fieldName: 'agree',
    });
    expect(report.fillMode).toBe('pdf-acroform');
    expect(report.unmatchedSlots).toEqual(['sig']);
  });
});
