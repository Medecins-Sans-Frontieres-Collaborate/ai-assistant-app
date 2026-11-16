import { create } from 'zustand';

/** What a held action is, so the confirmation can word itself. */
export type BudgetGatedActionKind = 'message' | 'run';

export interface PendingBudgetAction {
  kind: BudgetGatedActionKind;
  /** Performs the action the user asked for before the budget intervened. */
  run: () => void;
}

interface BudgetGateStore {
  /**
   * The one action currently waiting on an "ask first" confirmation, if any.
   * Not persisted: a held send does not survive a reload, and should not.
   */
  pending: PendingBudgetAction | null;
  hold: (action: PendingBudgetAction) => void;
  /** Runs the held action and clears it. */
  confirm: () => void;
  /** Drops the held action without running it. */
  cancel: () => void;
}

/**
 * Holds an action that a personal budget's "ask first" stage intercepted
 * (lib/utils/shared/usageBudgets.ts) until the user confirms or cancels.
 *
 * A store rather than component state because the action is raised in one
 * place (the composer, a workflow's run button) and confirmed in another
 * (the notice above the composer, the run dialog).
 */
export const useBudgetGateStore = create<BudgetGateStore>((set, get) => ({
  pending: null,
  hold: (action) => set({ pending: action }),
  confirm: () => {
    const { pending } = get();
    // Cleared first: the action may itself re-enter the gate.
    set({ pending: null });
    pending?.run();
  },
  cancel: () => set({ pending: null }),
}));
