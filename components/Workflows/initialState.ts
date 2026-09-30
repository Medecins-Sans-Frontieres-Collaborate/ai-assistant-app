import { emptyBrief } from '@/lib/utils/shared/drafter/core/brief';

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
    case 'grants':
      return {
        kind: 'grants',
        updatedAt,
      };
    case 'form-fill':
      // No document until a template is attached — ids are generated at
      // attach time, so a fresh state stays deterministic for the
      // pristine check in workflowDirty.ts.
      return {
        kind: 'form-fill',
        documents: [],
        sources: [],
        notes: [],
        updatedAt,
      };
    case 'channel-drafter':
      // `specIds` starts empty: the workspace fills it from the channels
      // remembered in settings, so a fresh state stays deterministic for the
      // pristine check in workflowDirty.ts.
      return {
        kind: 'channel-drafter',
        sources: [],
        brief: emptyBrief(),
        guideIds: [],
        specIds: [],
        layout: { hidden: [], pinned: [] },
        versions: {},
        nextId: 1,
        updatedAt,
      };
  }
}
