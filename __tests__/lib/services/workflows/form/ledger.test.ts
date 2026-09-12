import {
  Clock,
  addNote,
  answerQuestion,
  attachTemplate,
  recordFillRun,
  removeDocument,
  removeSource,
  resolveAllProposals,
  resolveProposal,
  setFieldDecision,
  setFieldValue,
} from '@/lib/services/workflows/form/ledger';
import { fieldStatus } from '@/lib/services/workflows/form/status';

import { FormFillWorkflowState, FormTemplate } from '@/types/formFill';

import { describe, expect, it } from 'vitest';

let counter = 0;
const clock: Clock = {
  now: () => '2026-01-01T00:00:00.000Z',
  mintId: () => `id-${++counter}`,
};

const template: FormTemplate = {
  id: 't',
  name: 'T',
  sections: [{ id: 's', heading: 'S' }],
  fields: [
    { id: 'a', sectionId: 's', label: 'A', type: 'text', required: true },
    { id: 'b', sectionId: 's', label: 'B', type: 'number', required: false },
    {
      id: 'org',
      sectionId: 's',
      label: 'Org',
      type: 'text',
      required: false,
      admin: { locked: true, prefill: { kind: 'constant', value: 'MSF' } },
    },
  ],
  layout: '',
  origin: 'user',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const empty: FormFillWorkflowState = {
  kind: 'form-fill',
  documents: [],
  sources: [],
  notes: [],
  updatedAt: '2026-01-01T00:00:00Z',
};

function attached() {
  return attachTemplate(empty, template, { language: 'English', clock });
}

describe('attachTemplate', () => {
  it('snapshots the template, activates the document, prefills locked constants', () => {
    const state = attached();
    expect(state.documents).toHaveLength(1);
    expect(state.activeDocumentId).toBe(state.documents[0].id);
    const doc = state.documents[0];
    expect(doc.templateRef).toEqual({
      origin: 'user',
      id: 't',
      updatedAt: template.updatedAt,
    });
    expect(doc.fields.org).toMatchObject({
      value: 'MSF',
      decision: 'confirmed',
    });
    expect(fieldStatus(template.fields[2], doc.fields.org).status).toBe(
      'confirmed',
    );
  });

  it('removeDocument reactivates the last remaining document', () => {
    let state = attached();
    state = attachTemplate(state, template, { language: 'French', clock });
    const [first, second] = state.documents;
    expect(state.activeDocumentId).toBe(second.id);
    state = removeDocument(state, second.id, clock.now());
    expect(state.activeDocumentId).toBe(first.id);
  });
});

describe('field edits (review fixes)', () => {
  it('never stores a confirmed empty value', () => {
    const doc = attached().documents[0];
    // An empty list from coerceInput-style input clears rather than confirms.
    expect(setFieldValue(doc, 'a', [], clock.now()).fields.a).toBeUndefined();
    // Confirming a field with nothing in it is a no-op.
    expect(setFieldDecision(doc, 'a', 'confirmed', clock.now())).toBe(doc);
  });

  it('a typed replacement drops the model provenance and confidence', () => {
    let doc = recordFillRun(
      attached().documents[0],
      {
        proposals: [
          {
            fieldId: 'a',
            value: 'model',
            confidence: 'high',
            provenance: [{ sourceId: 's1', excerpt: 'model' }],
          },
        ],
        questions: [],
        targetFieldIds: ['a'],
        sourceIds: ['s1'],
        mode: 'targeted',
      },
      clock,
    );
    doc = resolveAllProposals(doc, true, clock.now());
    const same = setFieldValue(doc, 'a', 'model', clock.now());
    expect(same.fields.a.provenance).toHaveLength(1);
    const replaced = setFieldValue(doc, 'a', 'user typed', clock.now());
    expect(replaced.fields.a).toMatchObject({
      value: 'user typed',
      decision: 'confirmed',
      provenance: [],
    });
    expect(replaced.fields.a.confidence).toBeUndefined();
  });

  it('a proposal for a field settled mid-run is rejected, not silently accepted', () => {
    let doc = recordFillRun(
      attached().documents[0],
      {
        proposals: [
          { fieldId: 'a', value: 'late', confidence: 'high', provenance: [] },
        ],
        questions: [],
        targetFieldIds: ['a'],
        sourceIds: [],
        mode: 'targeted',
      },
      clock,
    );
    doc = setFieldValue(doc, 'a', 'mine', clock.now());
    const next = resolveProposal(doc, doc.proposals[0].id, true, clock.now());
    expect(next.fields.a.value).toBe('mine');
    expect(next.proposals[0].status).toBe('rejected');
  });

  it('removing a source strips its citations from every document', () => {
    let state = attached();
    state = addNote(state, 'fact', { clock }).state;
    const sourceId = state.sources[0].id;
    let doc = recordFillRun(
      state.documents[0],
      {
        proposals: [
          {
            fieldId: 'a',
            value: 'x',
            confidence: 'high',
            provenance: [{ sourceId, excerpt: 'fact' }],
          },
        ],
        questions: [],
        targetFieldIds: ['a'],
        sourceIds: [sourceId],
        mode: 'targeted',
      },
      clock,
    );
    doc = resolveAllProposals(doc, true, clock.now());
    state = { ...state, documents: [doc] };
    const after = removeSource(state, sourceId, clock.now());
    expect(after.documents[0].fields.a.provenance).toEqual([]);
    expect(
      fieldStatus(template.fields[0], after.documents[0].fields.a).status,
    ).toBe('partial');
  });
});

describe('field edits', () => {
  it('a manual edit confirms; clearing returns to empty; locked is inert', () => {
    const doc = attached().documents[0];
    const edited = setFieldValue(doc, 'a', 'hello', clock.now());
    expect(fieldStatus(template.fields[0], edited.fields.a).status).toBe(
      'confirmed',
    );
    const cleared = setFieldValue(edited, 'a', '', clock.now());
    expect(cleared.fields.a).toBeUndefined();
    expect(setFieldValue(doc, 'org', 'x', clock.now())).toBe(doc);
  });

  it('decisions toggle and clear', () => {
    const doc = attached().documents[0];
    const na = setFieldDecision(doc, 'a', 'not_applicable', clock.now());
    expect(fieldStatus(template.fields[0], na.fields.a).status).toBe(
      'not_applicable',
    );
    const cleared = setFieldDecision(na, 'a', 'clear', clock.now());
    expect(cleared.fields.a).toBeUndefined();
  });
});

describe('fill runs and proposals', () => {
  const run = {
    proposals: [
      {
        fieldId: 'a',
        value: 'Water',
        confidence: 'high' as const,
        provenance: [{ sourceId: 's1', excerpt: 'Water' }],
      },
      {
        fieldId: 'b',
        value: null,
        gaps: 'no figure',
        confidence: 'low' as const,
        provenance: [],
      },
    ],
    questions: [{ text: 'What is the budget?', fieldIds: ['b'] }],
    targetFieldIds: ['a', 'b'],
    sourceIds: ['s1'],
    mode: 'targeted' as const,
  };

  it('queues proposals and questions; accept writes the ledger; reject leaves it', () => {
    let doc = recordFillRun(attached().documents[0], run, clock);
    expect(doc.proposals.map((p) => p.status)).toEqual(['pending', 'pending']);
    expect(doc.questions).toHaveLength(1);
    expect(doc.runs).toHaveLength(1);

    const accepted = resolveProposal(
      doc,
      doc.proposals[0].id,
      true,
      clock.now(),
    );
    expect(accepted.fields.a).toMatchObject({
      value: 'Water',
      confidence: 'high',
    });
    expect(fieldStatus(template.fields[0], accepted.fields.a).status).toBe(
      'filled',
    );

    const rejected = resolveProposal(
      doc,
      doc.proposals[0].id,
      false,
      clock.now(),
    );
    expect(rejected.fields.a).toBeUndefined();
    expect(rejected.proposals[0].status).toBe('rejected');
    doc = accepted;
  });

  it('a null-with-gaps proposal records the gap without inventing a value', () => {
    const doc = recordFillRun(attached().documents[0], run, clock);
    const next = resolveAllProposals(doc, true, clock.now());
    expect(next.fields.b).toMatchObject({ value: null, gaps: 'no figure' });
    expect(fieldStatus(template.fields[1], next.fields.b).status).toBe('empty');
    // The question about b stays open — b is still empty.
    expect(next.questions[0].status).toBe('open');
  });

  it('never overwrites a confirmed field, and a new run supersedes pending proposals', () => {
    let doc = setFieldValue(attached().documents[0], 'a', 'Mine', clock.now());
    doc = recordFillRun(doc, run, clock);
    doc = resolveAllProposals(doc, true, clock.now());
    expect(doc.fields.a.value).toBe('Mine');

    let fresh = recordFillRun(attached().documents[0], run, clock);
    fresh = recordFillRun(fresh, run, clock);
    expect(fresh.proposals.filter((p) => p.status === 'pending')).toHaveLength(
      2,
    );
  });
});

describe('sources, notes and questions', () => {
  it('notes become sources and answers close questions', () => {
    let state = attached();
    let doc = recordFillRun(
      state.documents[0],
      {
        proposals: [],
        questions: [{ text: 'Budget?', fieldIds: ['b'] }],
        targetFieldIds: ['b'],
        sourceIds: [],
        mode: 'targeted',
      },
      clock,
    );
    const question = doc.questions[0];
    const result = addNote(state, 'Budget is 12k', {
      clock,
      questionId: question.id,
    });
    state = result.state;
    expect(state.sources[0]).toMatchObject({
      kind: 'note',
      name: 'Budget is 12k',
    });
    expect(state.notes[0].sourceId).toBe(state.sources[0].id);
    doc = answerQuestion(doc, question.id, result.note.id);
    expect(doc.questions[0]).toMatchObject({
      status: 'answered',
      answerNoteId: result.note.id,
    });

    const removed = removeSource(state, state.sources[0].id, clock.now());
    expect(removed.sources).toEqual([]);
    expect(removed.notes).toEqual([]);
  });
});
