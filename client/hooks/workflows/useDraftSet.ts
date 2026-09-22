'use client';

import { useCallback, useMemo } from 'react';

import { DraftSetState } from '@/types/drafter';
import { ConversationWorkflowType, WorkflowState } from '@/types/workflow';

import { createInitialWorkflowState } from '@/components/Workflows/initialState';

import { useConversationStore } from '@/client/stores/conversationStore';

/** A drafter workflow's persisted state: the core plus its own `kind`. */
type DrafterState = Extract<WorkflowState, DraftSetState>;

export interface DraftSetHandle<S extends DrafterState> {
  state: S | undefined;
  modelId: string | undefined;
  /** The single write path; a no-op updater (same reference) writes nothing. */
  setState: (updater: (prev: S) => S) => void;
  /** Mints `count` ids and advances the counter in the same write. */
  mintIds: (prev: S, count: number) => { ids: string[]; next: S };
}

/**
 * State access for any workflow built on the drafter core. Kind-agnostic:
 * the caller names its conversationType and gets back its own state type.
 */
export function useDraftSet<S extends DrafterState>(
  conversationId: string,
  kind: S['kind'] & ConversationWorkflowType,
): DraftSetHandle<S> {
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId),
  );
  const updateWorkflowState = useConversationStore(
    (s) => s.updateWorkflowState,
  );
  const state =
    conversation?.workflowState?.kind === kind
      ? (conversation.workflowState as S)
      : undefined;

  const setState = useCallback(
    (updater: (prev: S) => S) => {
      updateWorkflowState(conversationId, (prev) => {
        if (prev?.kind === kind) return updater(prev as S);
        // No workflow state yet: apply the mutation to a fresh one rather
        // than dropping it. A state of another kind is left for the store
        // to refuse (kind mismatch).
        if (!prev) return updater(createInitialWorkflowState(kind) as S);
        return prev;
      });
    },
    [conversationId, kind, updateWorkflowState],
  );

  const mintIds = useCallback((prev: S, count: number) => {
    const ids = Array.from({ length: count }, (_, index) =>
      (prev.nextId + index).toString(36),
    );
    return { ids, next: { ...prev, nextId: prev.nextId + count } };
  }, []);

  return useMemo(
    () => ({ state, modelId: conversation?.model?.id, setState, mintIds }),
    [state, conversation?.model?.id, setState, mintIds],
  );
}
