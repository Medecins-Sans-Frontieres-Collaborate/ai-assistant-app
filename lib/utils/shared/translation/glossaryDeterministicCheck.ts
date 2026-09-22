/**
 * The glossary scan, expressed on the shared deterministic-check seam
 * (lib/utils/shared/review/deterministicChecks.ts).
 *
 * `checkGlossaryCompliance` stays the source of truth: the translation
 * orchestrator needs its full `GlossaryViolation` objects for the review
 * prompt and the analysis panel, and its event payload is pinned. This
 * adapter is for review surfaces that speak `CheckFinding`, so a glossary
 * violation can sit in the same list as any other code-decided fact.
 */
import {
  CheckFinding,
  DeterministicCheck,
} from '@/lib/utils/shared/review/deterministicChecks';

import { GlossaryEntry, GlossaryViolation } from '@/types/workflow';

import { checkGlossaryCompliance } from './glossaryMatch';

export interface GlossaryCheckCtx {
  entries: GlossaryEntry[];
  sourceText: string;
  translation: string;
}

/** One finding per required term the translation does not use. */
export function glossaryViolationsAsFindings(
  violations: GlossaryViolation[],
): CheckFinding[] {
  return violations.map((violation) => ({
    checkId: 'glossary',
    // A required term is a requirement: the scan is exact, so a miss is a
    // fact to fix, not an opinion to weigh.
    severity: 'block' as const,
    messageKey: 'glossaryTermMissing',
    values: {
      source: violation.source,
      target: violation.target,
      kind: violation.kind,
      matchedBy: violation.matchedBy,
    },
  }));
}

export const glossaryDeterministicCheck: DeterministicCheck<GlossaryCheckCtx> =
  {
    id: 'glossary',
    run: (ctx) =>
      glossaryViolationsAsFindings(
        checkGlossaryCompliance(ctx.entries, ctx.sourceText, ctx.translation)
          .violations,
      ),
  };
