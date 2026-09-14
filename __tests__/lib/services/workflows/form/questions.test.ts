import {
  mergeQuestions,
  openQuestions,
  retireQuestions,
  selectQuestionMode,
} from '@/lib/services/workflows/form/questions';

import { FormDocument, QuestionRecord } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

function doc(overrides: Partial<FormDocument> = {}): FormDocument {
  return {
    id: 'd',
    language: 'English',
    template: {
      id: 't',
      name: 'T',
      sections: [{ id: 's', heading: 'S' }],
      fields: [
        { id: 'a', sectionId: 's', label: 'A', type: 'text', required: true },
        { id: 'b', sectionId: 's', label: 'B', type: 'text', required: true },
        { id: 'c', sectionId: 's', label: 'C', type: 'text', required: false },
      ],
      layout: '',
      origin: 'user',
      createdAt: '',
      updatedAt: '',
    },
    fields: {},
    questions: [],
    runs: [],
    proposals: [],
    ...overrides,
  };
}

const q = (
  id: string,
  fieldIds: string[],
  status: QuestionRecord['status'] = 'open',
): QuestionRecord => ({
  id,
  mode: fieldIds.length ? 'targeted' : 'general',
  text: `Q ${id}`,
  fieldIds,
  status,
  askedAt: '',
});

describe('selectQuestionMode', () => {
  it('is general only with no material and low required coverage', () => {
    expect(selectQuestionMode(doc(), 0)).toBe('general');
    expect(selectQuestionMode(doc(), 1)).toBe('targeted');
    const covered = doc({
      fields: {
        a: { value: 'x', decision: 'confirmed', provenance: [], updatedAt: '' },
      },
    });
    // 1 of 2 required addressed = 50% ≥ 30%
    expect(selectQuestionMode(covered, 0)).toBe('targeted');
  });
});

describe('retireQuestions / openQuestions', () => {
  it('retires a question once all its fields are addressed', () => {
    const d = doc({
      fields: {
        a: { value: 'x', decision: 'confirmed', provenance: [], updatedAt: '' },
      },
      questions: [
        q('1', ['a']),
        q('2', ['a', 'b']),
        q('3', []),
        q('4', ['a'], 'answered'),
      ],
    });
    expect(retireQuestions(d).map((x) => x.id)).toEqual(['2', '3', '4']);
    expect(openQuestions(d).map((x) => x.id)).toEqual(['3', '2']);
  });
});

describe('mergeQuestions', () => {
  let n = 0;
  const opts = {
    mode: 'targeted' as const,
    now: 'now',
    mintId: () => `n${++n}`,
  };

  it('replaces open questions, keeps history, drops duplicates, caps at 3', () => {
    const existing = [q('old', ['a']), q('done', ['b'], 'answered')];
    const merged = mergeQuestions(
      existing,
      [
        { text: 'Q done', fieldIds: ['b'] },
        { text: 'New 1', fieldIds: ['a'] },
        { text: 'New 2', fieldIds: ['c'] },
        { text: 'New 3', fieldIds: ['a', 'c'] },
        { text: 'New 4', fieldIds: ['b'] },
        // A targeted question that names no field can never retire: dropped.
        { text: 'Orphan', fieldIds: [] },
      ],
      opts,
    );
    expect(merged.map((x) => x.text)).toEqual([
      'Q done',
      'New 1',
      'New 2',
      'New 3',
    ]);
    expect(merged[1]).toMatchObject({ status: 'open', mode: 'targeted' });
  });

  it('is a no-op without incoming questions', () => {
    const existing = [q('old', ['a'])];
    expect(mergeQuestions(existing, [], opts)).toBe(existing);
  });
});
