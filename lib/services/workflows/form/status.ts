import {
  FieldFill,
  FillStatus,
  FormDocument,
  FormField,
} from '@/types/formFill';

import { FieldIssue, isEmptyValue, validateField } from './validation';

/**
 * Status derivation — the ledger can never disagree with the data because
 * the status is COMPUTED from the fill record, never stored.
 *
 *  - empty:           no value
 *  - partial:         value present but a validator fails, the model reported
 *                     gaps, or the value has no supporting source and is not
 *                     marked general knowledge
 *  - filled:          value present, validators pass, no gaps, sourced
 *  - confirmed:       user accepted/edited it, or the field is admin-locked
 *                     (locked always reads confirmed, value or not)
 *  - not_applicable:  user marked it N/A (counts as addressed)
 */
export interface FieldStatusResult {
  status: FillStatus;
  issues: FieldIssue[];
  /** Human reasons a value is only partial, beyond validator issues. */
  partialReasons: Array<'gaps' | 'unsourced' | 'rubric'>;
}

export function isLocked(field: FormField): boolean {
  return field.admin?.locked === true;
}

export function fieldStatus(
  field: FormField,
  fill: FieldFill | undefined,
): FieldStatusResult {
  if (fill?.decision === 'not_applicable') {
    return { status: 'not_applicable', issues: [], partialReasons: [] };
  }
  const issues = validateField(field, fill?.value);
  // A locked field is the admin's decision even when it resolved to
  // nothing: it counts as addressed and is never open for the user.
  if (isLocked(field)) {
    return { status: 'confirmed', issues, partialReasons: [] };
  }
  if (!fill || isEmptyValue(fill.value)) {
    return { status: 'empty', issues, partialReasons: [] };
  }
  if (fill.decision === 'confirmed') {
    return { status: 'confirmed', issues, partialReasons: [] };
  }
  const partialReasons: FieldStatusResult['partialReasons'] = [];
  if (fill.gaps && fill.gaps.trim() !== '') partialReasons.push('gaps');
  if (fill.provenance.length === 0 && !fill.generalKnowledge) {
    partialReasons.push('unsourced');
  }
  if (fill.rubric && !fill.rubric.ok) partialReasons.push('rubric');
  const status: FillStatus =
    issues.length > 0 || partialReasons.length > 0 ? 'partial' : 'filled';
  return { status, issues, partialReasons };
}

export interface Coverage {
  total: number;
  empty: number;
  partial: number;
  filled: number;
  confirmed: number;
  notApplicable: number;
  /** (filled + confirmed + notApplicable) / total; 0 for an empty template. */
  ratio: number;
  requiredTotal: number;
  requiredAddressed: number;
  requiredRatio: number;
}

/** Whether a status counts as "addressed" for coverage. */
export function isAddressed(status: FillStatus): boolean {
  return (
    status === 'filled' || status === 'confirmed' || status === 'not_applicable'
  );
}

export function coverageOf(document: FormDocument): Coverage {
  const counts = {
    empty: 0,
    partial: 0,
    filled: 0,
    confirmed: 0,
    notApplicable: 0,
  };
  let requiredTotal = 0;
  let requiredAddressed = 0;
  for (const field of document.template.fields) {
    const { status } = fieldStatus(field, document.fields[field.id]);
    if (status === 'not_applicable') counts.notApplicable += 1;
    else counts[status] += 1;
    if (field.required) {
      requiredTotal += 1;
      if (isAddressed(status)) requiredAddressed += 1;
    }
  }
  const total = document.template.fields.length;
  const addressed = counts.filled + counts.confirmed + counts.notApplicable;
  return {
    total,
    ...counts,
    ratio: total === 0 ? 0 : addressed / total,
    requiredTotal,
    requiredAddressed,
    requiredRatio: requiredTotal === 0 ? 1 : requiredAddressed / requiredTotal,
  };
}

/** Fields a fill run may target: never confirmed, locked, or N/A. */
export function fillableFieldIds(document: FormDocument): string[] {
  return document.template.fields
    .filter((field) => {
      if (isLocked(field)) return false;
      const { status } = fieldStatus(field, document.fields[field.id]);
      return status !== 'confirmed' && status !== 'not_applicable';
    })
    .map((field) => field.id);
}

/** Fields still needing work (empty or partial), required first. */
export function openFieldIds(document: FormDocument): string[] {
  const open = document.template.fields.filter((field) => {
    if (isLocked(field)) return false; // nothing the user or a run can do
    const { status } = fieldStatus(field, document.fields[field.id]);
    return status === 'empty' || status === 'partial';
  });
  return [
    ...open.filter((f) => f.required),
    ...open.filter((f) => !f.required),
  ].map((f) => f.id);
}
