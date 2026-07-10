import { ComponentType, LazyExoticComponent, lazy } from 'react';

import { Conversation } from '@/types/chat';
import { ConversationWorkflowType, WorkflowState } from '@/types/workflow';

import { createInitialWorkflowState } from './initialState';
import { WORKFLOW_META, WorkflowMeta } from './registryMeta';

/**
 * Props every workflow workspace receives. Workspaces read their
 * conversation (and workflowState) from the conversation store themselves;
 * state writes go through conversationStore.updateWorkflowState.
 */
export interface WorkflowWorkspaceProps {
  conversationId: string;
}

/** Contract for a workflow-specific rail send override. */
export interface RailSendModule {
  sendRailMessage(conversation: Conversation, text: string): Promise<void>;
}

export interface WorkflowDefinition {
  meta: WorkflowMeta;
  /**
   * Lazy so heavyweight workspace dependencies (map, data grid, editor)
   * stay out of the chat bundle until a workflow window actually opens.
   */
  Workspace: LazyExoticComponent<ComponentType<WorkflowWorkspaceProps>>;
  createInitialState: () => WorkflowState;
  /**
   * Optional override for the conversation rail's send path (dynamic
   * import keeps it lazy). Without it the rail uses the generic /api/chat
   * pipeline.
   */
  railSend?: () => Promise<RailSendModule>;
}

export const WORKFLOW_REGISTRY: Record<
  ConversationWorkflowType,
  WorkflowDefinition
> = {
  translation: {
    meta: WORKFLOW_META.translation,
    Workspace: lazy(() =>
      import('./Translation/TranslationWorkspace').then((m) => ({
        default: m.TranslationWorkspace,
      })),
    ),
    createInitialState: () => createInitialWorkflowState('translation'),
  },
  document: {
    meta: WORKFLOW_META.document,
    Workspace: lazy(() =>
      import('./Document/DocumentWorkspace').then((m) => ({
        default: m.DocumentWorkspace,
      })),
    ),
    createInitialState: () => createInitialWorkflowState('document'),
  },
  'data-analysis': {
    meta: WORKFLOW_META['data-analysis'],
    Workspace: lazy(() =>
      import('./Data/DataWorkspace').then((m) => ({
        default: m.DataWorkspace,
      })),
    ),
    createInitialState: () => createInitialWorkflowState('data-analysis'),
    // Data rail chat answers questions grounded in the table digest
    // (read-only — the transform bar is the single write path).
    railSend: () => import('@/client/services/workflows/data/dataRailChat'),
  },
  map: {
    meta: WORKFLOW_META.map,
    Workspace: lazy(() =>
      import('./Map/MapWorkspace').then((m) => ({
        default: m.MapWorkspace,
      })),
    ),
    createInitialState: () => createInitialWorkflowState('map'),
    // Map rail chat is grounded in the mapped data and can add
    // events/connections; see docs/MAP_WORKFLOW.md.
    railSend: () => import('@/client/services/workflows/map/mapRailChat'),
  },
};
