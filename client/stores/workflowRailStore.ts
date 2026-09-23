import { RevisionScope } from '@/types/drafter';

import { create } from 'zustand';

/**
 * Transient, unpersisted coordination between a workflow's workspace and the
 * shell's chat rail. The rail's open state is local to WorkflowShell, so a
 * workspace asks for it through `requestOpen`; the drafter also parks the
 * scope of the next revision here, where the rail's send module reads it.
 */
interface WorkflowRailState {
  /** Bumped to ask the shell to open the rail. */
  openRequest: number;
  requestOpen: () => void;
  /** Who the next revision instruction is addressed to, per conversation. */
  scopes: Record<string, RevisionScope>;
  setScope: (conversationId: string, scope: RevisionScope) => void;
}

export const EVERY_SPEC: RevisionScope = { specIds: [] };

export const useWorkflowRailStore = create<WorkflowRailState>((set) => ({
  openRequest: 0,
  requestOpen: () => set((state) => ({ openRequest: state.openRequest + 1 })),
  scopes: {},
  setScope: (conversationId, scope) =>
    set((state) => ({
      scopes: { ...state.scopes, [conversationId]: scope },
    })),
}));
