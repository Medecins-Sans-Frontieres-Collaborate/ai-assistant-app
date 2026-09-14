import {
  DocumentRuleResult,
  FORM_LIMITS,
  FieldFill,
  FieldProposal,
  FieldValue,
  FillNote,
  FillSourceRecord,
  FormDocument,
  FormFillWorkflowState,
  FormTemplate,
  QuestionRecord,
} from '@/types/formFill';

import { PrefillUser, resolvePrefill } from './adminValues';
import { NormalizedProposal } from './fillSchema';
import { mergeQuestions, retireQuestions } from './questions';
import { isLocked } from './status';
import { formatValue, isEmptyValue } from './validation';

/**
 * Pure state transitions for the form-fill ledger. The workspace calls
 * these inside `updateWorkflowState`; nothing here touches React or the
 * store, so every transition is unit-testable and the single write path
 * is auditable in one file.
 */

export interface Clock {
  now: () => string;
  mintId: () => string;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

/**
 * Admin prefills resolve at attach: a locked field starts confirmed; an
 * unlocked prefill starts as a normal, editable value (marked general
 * knowledge so it reads as filled rather than unsourced).
 */
function initialFills(
  template: FormTemplate,
  clock: Clock,
  prefillUser: PrefillUser | undefined,
): Record<string, FieldFill> {
  const fills: Record<string, FieldFill> = {};
  for (const field of template.fields) {
    if (!field.admin?.prefill) continue;
    const value = resolvePrefill(field, prefillUser);
    if (value === null) continue;
    fills[field.id] = {
      decision: field.admin.locked ? 'confirmed' : undefined,
      value,
      provenance: [],
      generalKnowledge: true,
      updatedAt: clock.now(),
    };
  }
  return fills;
}

export function attachTemplate(
  state: FormFillWorkflowState,
  template: FormTemplate,
  options: { language: string; clock: Clock; prefillUser?: PrefillUser },
): FormFillWorkflowState {
  if (state.documents.length >= FORM_LIMITS.MAX_DOCUMENTS) return state;
  const document: FormDocument = {
    id: options.clock.mintId(),
    template,
    templateRef: {
      origin: template.origin,
      id: template.id,
      updatedAt: template.updatedAt,
    },
    language: options.language,
    fields: initialFills(template, options.clock, options.prefillUser),
    questions: [],
    runs: [],
    proposals: [],
  };
  return {
    ...state,
    documents: [...state.documents, document],
    activeDocumentId: document.id,
    updatedAt: options.clock.now(),
  };
}

export function removeDocument(
  state: FormFillWorkflowState,
  documentId: string,
  now: string,
): FormFillWorkflowState {
  const documents = state.documents.filter((d) => d.id !== documentId);
  if (documents.length === state.documents.length) return state;
  return {
    ...state,
    documents,
    activeDocumentId:
      state.activeDocumentId === documentId
        ? documents[documents.length - 1]?.id
        : state.activeDocumentId,
    updatedAt: now,
  };
}

export function updateDocument(
  state: FormFillWorkflowState,
  documentId: string,
  updater: (document: FormDocument) => FormDocument,
  now: string,
): FormFillWorkflowState {
  let changed = false;
  const documents = state.documents.map((d) => {
    if (d.id !== documentId) return d;
    const next = updater(d);
    if (next !== d) changed = true;
    return next;
  });
  return changed ? { ...state, documents, updatedAt: now } : state;
}

/* ------------------------------------------------------------------ */
/* Field edits                                                         */
/* ------------------------------------------------------------------ */

/**
 * A manual edit: the user's value, confirmed. Model provenance, confidence
 * and gaps describe the value the model proposed, so they are dropped
 * unless the value is unchanged (the user merely confirmed it).
 */
export function setFieldValue(
  document: FormDocument,
  fieldId: string,
  value: FieldValue,
  now: string,
): FormDocument {
  const field = document.template.fields.find((f) => f.id === fieldId);
  if (!field || isLocked(field)) return document;
  const previous = document.fields[fieldId];
  if (isEmptyValue(value)) {
    // Clearing a field returns it to empty, not "confirmed empty".
    if (!previous) return document;
    const { [fieldId]: _removed, ...rest } = document.fields;
    void _removed;
    return { ...document, fields: rest };
  }
  const unchanged =
    previous !== undefined &&
    formatValue(previous.value) === formatValue(value);
  const fill: FieldFill = {
    decision: previous?.decision === 'not_applicable' ? undefined : 'confirmed',
    value,
    provenance: unchanged ? (previous?.provenance ?? []) : [],
    confidence: unchanged ? previous?.confidence : undefined,
    generalKnowledge: unchanged ? previous?.generalKnowledge : undefined,
    updatedAt: now,
  };
  return { ...document, fields: { ...document.fields, [fieldId]: fill } };
}

export function setFieldDecision(
  document: FormDocument,
  fieldId: string,
  decision: FieldFill['decision'] | 'clear',
  now: string,
): FormDocument {
  const field = document.template.fields.find((f) => f.id === fieldId);
  if (!field || isLocked(field)) return document;
  const previous = document.fields[fieldId] ?? {
    value: null,
    provenance: [],
    updatedAt: now,
  };
  // "Confirmed" needs something to confirm; an empty field cannot be
  // locked in as empty (it would read empty yet refuse every proposal).
  if (decision === 'confirmed' && isEmptyValue(previous.value)) return document;
  const fill: FieldFill = {
    ...previous,
    decision: decision === 'clear' ? undefined : decision,
    updatedAt: now,
  };
  if (fill.decision === undefined && fill.value === null) {
    const { [fieldId]: _removed, ...rest } = document.fields;
    void _removed;
    return { ...document, fields: rest };
  }
  return { ...document, fields: { ...document.fields, [fieldId]: fill } };
}

/* ------------------------------------------------------------------ */
/* Fill runs and proposals                                             */
/* ------------------------------------------------------------------ */

export function recordFillRun(
  document: FormDocument,
  run: {
    proposals: NormalizedProposal[];
    questions: Array<{ text: string; fieldIds: string[] }>;
    targetFieldIds: string[];
    sourceIds: string[];
    modelId?: string;
    mode: 'general' | 'targeted';
  },
  clock: Clock,
): FormDocument {
  const runId = clock.mintId();
  const now = clock.now();
  // A new run's proposal for a field supersedes an older pending one.
  const superseded = new Set(run.proposals.map((p) => p.fieldId));
  const kept = document.proposals.filter(
    (p) => !(p.status === 'pending' && superseded.has(p.fieldId)),
  );
  const proposals: FieldProposal[] = run.proposals.map((p) => ({
    id: clock.mintId(),
    fieldId: p.fieldId,
    value: p.value,
    gaps: p.gaps,
    confidence: p.confidence,
    provenance: p.provenance,
    generalKnowledge: p.generalKnowledge,
    status: 'pending',
    runId,
  }));
  return {
    ...document,
    proposals: [...kept, ...proposals],
    questions: mergeQuestions(retireQuestions(document), run.questions, {
      mode: run.mode,
      now,
      mintId: clock.mintId,
    }),
    runs: [
      ...document.runs,
      {
        id: runId,
        at: now,
        modelId: run.modelId,
        fieldIds: run.targetFieldIds,
        sourceIds: run.sourceIds,
        proposedFieldIds: proposals.map((p) => p.fieldId),
      },
    ].slice(-50),
  };
}

export function resolveProposal(
  document: FormDocument,
  proposalId: string,
  accept: boolean,
  now: string,
): FormDocument {
  const proposal = document.proposals.find((p) => p.id === proposalId);
  if (!proposal || proposal.status !== 'pending') return document;
  const proposals = document.proposals.map((p) =>
    p.id === proposalId
      ? { ...p, status: accept ? ('accepted' as const) : ('rejected' as const) }
      : p,
  );
  if (!accept) return { ...document, proposals };
  const field = document.template.fields.find((f) => f.id === proposal.fieldId);
  if (!field || isLocked(field)) return { ...document, proposals };
  const previous = document.fields[proposal.fieldId];
  const settled =
    previous?.decision === 'not_applicable' ||
    (previous?.decision === 'confirmed' && !isEmptyValue(previous.value));
  if (settled) {
    // The user settled this field while the run was in flight: the
    // proposal is moot and must not read as applied.
    return {
      ...document,
      proposals: proposals.map((p) =>
        p.id === proposalId ? { ...p, status: 'rejected' as const } : p,
      ),
    };
  }
  let fields = document.fields;
  if (proposal.value !== null) {
    fields = {
      ...fields,
      [proposal.fieldId]: {
        value: proposal.value,
        gaps: proposal.gaps,
        confidence: proposal.confidence,
        provenance: proposal.provenance,
        generalKnowledge: proposal.generalKnowledge,
        updatedAt: now,
      },
    };
  } else if (proposal.gaps) {
    // A null value with gaps: keep whatever value exists, record the gap.
    fields = {
      ...fields,
      [proposal.fieldId]: {
        ...(previous ?? { value: null, provenance: [], updatedAt: now }),
        gaps: proposal.gaps,
        updatedAt: now,
      },
    };
  }
  return {
    ...document,
    fields,
    proposals,
    questions: retireQuestions({ ...document, fields }),
  };
}

export function resolveAllProposals(
  document: FormDocument,
  accept: boolean,
  now: string,
): FormDocument {
  let next = document;
  for (const proposal of document.proposals) {
    if (proposal.status === 'pending') {
      next = resolveProposal(next, proposal.id, accept, now);
    }
  }
  return next;
}

export function clearResolvedProposals(document: FormDocument): FormDocument {
  const proposals = document.proposals.filter((p) => p.status === 'pending');
  return proposals.length === document.proposals.length
    ? document
    : { ...document, proposals };
}

/* ------------------------------------------------------------------ */
/* Sources, notes, questions                                           */
/* ------------------------------------------------------------------ */

export function addSource(
  state: FormFillWorkflowState,
  source: FillSourceRecord,
): FormFillWorkflowState {
  if (state.sources.some((s) => s.id === source.id)) return state;
  return {
    ...state,
    sources: [...state.sources, source],
    updatedAt: source.addedAt,
  };
}

export function removeSource(
  state: FormFillWorkflowState,
  sourceId: string,
  now: string,
): FormFillWorkflowState {
  // Citations of a removed source go with it: a value it alone supported
  // reads as unsourced (partial) from now on, which is the truth.
  const documents = state.documents.map((doc) => {
    let changed = false;
    const fields: Record<string, FieldFill> = {};
    for (const [id, fill] of Object.entries(doc.fields)) {
      if (fill.provenance.some((p) => p.sourceId === sourceId)) {
        changed = true;
        fields[id] = {
          ...fill,
          provenance: fill.provenance.filter((p) => p.sourceId !== sourceId),
          updatedAt: now,
        };
      } else fields[id] = fill;
    }
    return changed ? { ...doc, fields } : doc;
  });
  return {
    ...state,
    documents,
    sources: state.sources.filter((s) => s.id !== sourceId),
    notes: state.notes.filter((n) => n.sourceId !== sourceId),
    updatedAt: now,
  };
}

/** Adds a note as a `note` source so provenance can cite it. */
export function addNote(
  state: FormFillWorkflowState,
  text: string,
  options: { clock: Clock; questionId?: string; name?: string },
): { state: FormFillWorkflowState; note: FillNote } {
  const now = options.clock.now();
  const sourceId = options.clock.mintId();
  const note: FillNote = {
    id: options.clock.mintId(),
    sourceId,
    text: text.trim().slice(0, FORM_LIMITS.MAX_NOTE_CHARS),
    questionId: options.questionId,
    createdAt: now,
  };
  const source: FillSourceRecord = {
    id: sourceId,
    kind: 'note',
    name: options.name ?? noteName(note.text),
    chars: note.text.length,
    addedAt: now,
  };
  return {
    state: {
      ...state,
      sources: [...state.sources, source],
      notes: [...state.notes, note],
      updatedAt: now,
    },
    note,
  };
}

function noteName(text: string): string {
  const line = text.split('\n')[0].trim();
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || 'Note';
}

export function answerQuestion(
  document: FormDocument,
  questionId: string,
  noteId: string,
): FormDocument {
  const questions: QuestionRecord[] = document.questions.map((q) =>
    q.id === questionId
      ? { ...q, status: 'answered', answerNoteId: noteId }
      : q,
  );
  return { ...document, questions };
}

export function skipQuestion(
  document: FormDocument,
  questionId: string,
): FormDocument {
  return {
    ...document,
    questions: document.questions.map((q) =>
      q.id === questionId ? { ...q, status: 'skipped' } : q,
    ),
  };
}

export function setLanguage(
  document: FormDocument,
  language: string,
): FormDocument {
  const trimmed = language.trim().slice(0, 60);
  if (!trimmed || trimmed === document.language) return document;
  return { ...document, language: trimmed };
}

/* ------------------------------------------------------------------ */
/* Validate pass                                                       */
/* ------------------------------------------------------------------ */

/**
 * Records rubric verdicts on the checked fields and rule verdicts on the
 * document. A confirmed field keeps its value but still shows the verdict;
 * a later edit clears it (setFieldValue rebuilds the fill without rubric).
 */
export function applyValidation(
  document: FormDocument,
  result: {
    fields: Record<string, { ok: boolean; note: string }>;
    rules: DocumentRuleResult[];
  },
  now: string,
): FormDocument {
  const fields = { ...document.fields };
  for (const [fieldId, verdict] of Object.entries(result.fields)) {
    const existing = fields[fieldId];
    if (!existing) continue;
    fields[fieldId] = {
      ...existing,
      rubric: { ok: verdict.ok, note: verdict.note, checkedAt: now },
    };
  }
  return { ...document, fields, ruleResults: result.rules };
}
