import { ConversationWorkflowType, WorkflowState } from '@/types/workflow';

/**
 * Fresh workflow state for a newly created workflow conversation. Leaf
 * module (no component imports) so creation entry points — Sidebar, the
 * empty-state chooser — can use it without touching the lazy registry.
 */
export function createInitialWorkflowState(
  type: ConversationWorkflowType,
): WorkflowState {
  const updatedAt = new Date().toISOString();
  switch (type) {
    case 'translation':
      return {
        kind: 'translation',
        sourceText: '',
        mode: 'agentic',
        rounds: [],
        updatedAt,
      };
    case 'document':
      return {
        kind: 'document',
        title: '',
        docHtml: '',
        references: [],
        revisions: [],
        updatedAt,
      };
    case 'data-analysis':
      return {
        kind: 'data-analysis',
        columns: [],
        rows: [],
        sources: [],
        operations: [],
        updatedAt,
      };
    case 'map':
      return {
        kind: 'map',
        features: [],
        sources: [],
        updatedAt,
      };
  }
}
