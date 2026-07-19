import { ConversationWorkflowType, WorkflowState } from '@/types/workflow';

import { createInitialWorkflowState } from './initialState';

/**
 * Whether a workflow's state still matches the state it was created with,
 * i.e. the user has put nothing into it yet.
 *
 * Used by WorkflowTabs to decide between switching silently and asking to
 * discard. Deliberately generic — a structural comparison against a fresh
 * initial state rather than a per-type "has the user typed anything" check,
 * so adding a workflow type needs no change here.
 *
 * Leaf module (no component imports), same as initialState.ts.
 */
export function isWorkflowStatePristine(
  state: WorkflowState | undefined,
  type: ConversationWorkflowType,
): boolean {
  if (!state) return true;
  // A state whose kind disagrees with the type is already broken; treat it
  // as content-bearing so the user is asked before it's thrown away.
  if (state.kind !== type) return false;
  return canonical(state) === canonical(createInitialWorkflowState(type));
}

/**
 * Order-independent JSON with `updatedAt` and undefined values removed.
 *
 * `createInitialWorkflowState` stamps `updatedAt` with the current time, so
 * a fresh initial state never equals a stored one by plain JSON compare.
 * Key order also drifts once state has been through persist/rehydrate, so
 * keys are sorted rather than compared positionally.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => key !== 'updatedAt' && entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}
