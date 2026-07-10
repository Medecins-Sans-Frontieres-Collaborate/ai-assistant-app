import {
  IconFileText,
  IconLanguage,
  IconMap,
  IconTable,
} from '@tabler/icons-react';

import { ConversationWorkflowType } from '@/types/workflow';

/**
 * Leaf metadata for workflow types: icons and i18n keys only.
 *
 * This module is deliberately separate from registry.tsx (which holds the
 * React.lazy workspace components) so that the Sidebar and other shell
 * surfaces can show workflow icons without pulling workspace chunks into
 * their bundle. Never import registry.tsx from here or from Sidebar code.
 */

type TablerIcon = typeof IconLanguage;

export interface WorkflowMeta {
  type: ConversationWorkflowType;
  icon: TablerIcon;
  /** Key under the `workflows.types.*` namespace in messages/en.json. */
  i18nKey: 'translation' | 'document' | 'dataAnalysis' | 'map';
}

export const WORKFLOW_META: Record<ConversationWorkflowType, WorkflowMeta> = {
  translation: {
    type: 'translation',
    icon: IconLanguage,
    i18nKey: 'translation',
  },
  document: {
    type: 'document',
    icon: IconFileText,
    i18nKey: 'document',
  },
  'data-analysis': {
    type: 'data-analysis',
    icon: IconTable,
    i18nKey: 'dataAnalysis',
  },
  map: {
    type: 'map',
    icon: IconMap,
    i18nKey: 'map',
  },
};

export function getWorkflowMeta(type: ConversationWorkflowType): WorkflowMeta {
  return WORKFLOW_META[type];
}
