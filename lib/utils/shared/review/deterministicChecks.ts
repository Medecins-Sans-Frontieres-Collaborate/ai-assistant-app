/**
 * The seam for checks that code can decide without a model.
 *
 * A deterministic finding is a FACT ("12 characters over", "this quote is
 * not in the brief"), so review surfaces list them before model suggestions
 * and never ask a model whether they are true. A finding with a mechanical
 * fix carries it as an ordinary `ReviewEdit`, so it rides the normal
 * accept / reject queue.
 *
 * Generic on the context so any workflow can define checks over its own
 * shape; the drafter is the first user.
 */
import { ReviewEdit } from '@/types/workflow';

/** `block`: must be resolved before publishing. `warn`: worth a look. */
export type CheckSeverity = 'block' | 'warn';

export interface CheckFinding {
  checkId: string;
  severity: CheckSeverity;
  /** The unit the finding is about (a segment, a field), when there is one. */
  targetId?: string;
  range?: { start: number; end: number };
  /** Key under `checks.*` of the messages namespace named by `scope`. */
  messageKey: string;
  /**
   * Whose messages hold `messageKey`: the shared surface's own ('core', the
   * default) or the adapter's ('kind'), e.g. a channel's length check.
   */
  scope?: 'core' | 'kind';
  values?: Record<string, string | number>;
  edit?: ReviewEdit;
}

export interface DeterministicCheck<Ctx> {
  id: string;
  run(ctx: Ctx): CheckFinding[];
}

/** Runs every check; one throwing check never hides the others' findings. */
export function runChecks<Ctx>(
  checks: ReadonlyArray<DeterministicCheck<Ctx>>,
  ctx: Ctx,
): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const check of checks) {
    try {
      findings.push(...check.run(ctx));
    } catch (error) {
      console.error(`[deterministicChecks] ${check.id} failed`, error);
    }
  }
  return findings;
}

export function blockingCount(findings: CheckFinding[]): number {
  return findings.filter((finding) => finding.severity === 'block').length;
}
