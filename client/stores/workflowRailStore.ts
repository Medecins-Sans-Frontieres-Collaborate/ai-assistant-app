import { RevisionScope } from '@/types/drafter';

import { create } from 'zustand';

/**
 * Transient, unpersisted coordination between a workflow's workspace and the
 * shell's chat rail. The rail's open state is local to WorkflowShell, so a
 * workspace asks for it through `requestOpen`; the drafter also parks the
 * scope of the next revision here, where the rail's send module reads it.
 */
/**
 * An instruction typed in the rail that only the workspace can carry out,
 * because the workspace holds what the request needs (the text in view, the
 * language, the glossaries) and shows the result.
 */
export interface RailWorkspaceRequest {
  id: string;
  text: string;
  /** Aborted when the user presses the rail's stop button. */
  signal?: AbortSignal;
  /** Called once by the workspace with what to say back in the rail. */
  settle: (reply: string) => void;
}

interface WorkflowRailState {
  /** Bumped to ask the shell to open the rail. */
  openRequest: number;
  requestOpen: () => void;
  /** Who the next revision instruction is addressed to, per conversation. */
  scopes: Record<string, RevisionScope>;
  setScope: (conversationId: string, scope: RevisionScope) => void;
  /** Bumped to ask the shell to bring the workspace into view (mobile). */
  workspaceRequest: number;
  requestWorkspace: () => void;
  /** At most one parked rail instruction per conversation. */
  workspaceRequests: Record<string, RailWorkspaceRequest>;
  submitWorkspaceRequest: (
    conversationId: string,
    request: RailWorkspaceRequest,
  ) => void;
  /**
   * Removes and returns the parked request, so exactly one caller acts on
   * it. `id` limits the removal to that request.
   */
  takeWorkspaceRequest: (
    conversationId: string,
    id?: string,
  ) => RailWorkspaceRequest | undefined;
}

export const EVERY_SPEC: RevisionScope = { specIds: [] };

export const useWorkflowRailStore = create<WorkflowRailState>((set, get) => ({
  openRequest: 0,
  requestOpen: () => set((state) => ({ openRequest: state.openRequest + 1 })),
  scopes: {},
  setScope: (conversationId, scope) =>
    set((state) => ({
      scopes: { ...state.scopes, [conversationId]: scope },
    })),
  workspaceRequest: 0,
  requestWorkspace: () =>
    set((state) => ({ workspaceRequest: state.workspaceRequest + 1 })),
  workspaceRequests: {},
  submitWorkspaceRequest: (conversationId, request) =>
    set((state) => ({
      workspaceRequests: {
        ...state.workspaceRequests,
        [conversationId]: request,
      },
    })),
  takeWorkspaceRequest: (conversationId, id) => {
    const request = get().workspaceRequests[conversationId];
    if (!request || (id !== undefined && request.id !== id)) return undefined;
    set((state) => {
      const rest = { ...state.workspaceRequests };
      delete rest[conversationId];
      return { workspaceRequests: rest };
    });
    return request;
  },
}));
