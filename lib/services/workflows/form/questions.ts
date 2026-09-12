import {
  FORM_LIMITS,
  FormDocument,
  QuestionMode,
  QuestionRecord,
} from '@/types/formFill';

import { coverageOf, fieldStatus } from './status';

/**
 * The question engine's deterministic half (docs/DOCUMENT_FILL_ASSESSMENT.md
 * §6a). The model writes the questions; this module decides the MODE from
 * ledger coverage and retires questions whose fields have been addressed,
 * so the assistant cannot drift back to vague questions once the form is
 * mostly done.
 */

const GENERAL_THRESHOLD = 0.3;

export function selectQuestionMode(
  document: FormDocument,
  sourceCount: number,
): QuestionMode {
  const coverage = coverageOf(document);
  const requiredRatio =
    coverage.requiredTotal === 0 ? coverage.ratio : coverage.requiredRatio;
  return sourceCount === 0 && requiredRatio < GENERAL_THRESHOLD
    ? 'general'
    : 'targeted';
}

/**
 * A question retires when every field it named has left empty/partial. A
 * general question (no fields) retires once it is answered or skipped —
 * only the user can close it.
 */
export function retireQuestions(document: FormDocument): QuestionRecord[] {
  const byId = new Map(document.template.fields.map((f) => [f.id, f]));
  return document.questions.filter((question) => {
    if (question.status !== 'open') return true;
    if (question.fieldIds.length === 0) return true;
    const stillOpen = question.fieldIds.some((id) => {
      const field = byId.get(id);
      if (!field) return false;
      const { status } = fieldStatus(field, document.fields[id]);
      return status === 'empty' || status === 'partial';
    });
    return stillOpen;
  });
}

/** Open questions, at most one round's worth, most recent first. */
export function openQuestions(document: FormDocument): QuestionRecord[] {
  return retireQuestions(document)
    .filter((q) => q.status === 'open')
    .slice(-FORM_LIMITS.MAX_QUESTIONS_PER_ROUND)
    .reverse();
}

/**
 * Merges a run's new questions: exact-text duplicates are dropped, and a
 * non-empty new round replaces older OPEN questions so the user never faces
 * a growing pile (a run that asked nothing keeps the current ones) —
 * answered/skipped records are history and stay.
 */
export function mergeQuestions(
  existing: QuestionRecord[],
  incoming: Array<{ text: string; fieldIds: string[] }>,
  options: { mode: QuestionMode; now: string; mintId: () => string },
): QuestionRecord[] {
  if (incoming.length === 0) return existing;
  const history = existing.filter((q) => q.status !== 'open');
  const seen = new Set(history.map((q) => q.text.trim().toLowerCase()));
  const fresh: QuestionRecord[] = [];
  for (const q of incoming) {
    // A targeted question whose fields were all filtered (unknown ids)
    // would never retire — drop it rather than promote it to general.
    if (options.mode === 'targeted' && q.fieldIds.length === 0) continue;
    const key = q.text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({
      id: options.mintId(),
      mode: options.mode,
      text: q.text,
      fieldIds: q.fieldIds,
      status: 'open',
      askedAt: options.now,
    });
  }
  return [...history, ...fresh.slice(0, FORM_LIMITS.MAX_QUESTIONS_PER_ROUND)];
}
