import {
  createDefaultConversation,
  createWorkflowConversation,
} from '@/lib/utils/app/conversationInit';

import { TranslationWorkflowState } from '@/types/workflow';

import { describe, expect, it } from 'vitest';

const models = [
  { id: 'gpt-4', name: 'GPT-4', maxLength: 4000, tokenLimit: 4000 },
  { id: 'gpt-5', name: 'GPT-5', maxLength: 8000, tokenLimit: 8000 },
];

describe('createWorkflowConversation', () => {
  it('creates an empty conversation carrying the workflow type', () => {
    const conversation = createWorkflowConversation(
      models,
      'gpt-5',
      'system',
      0.5,
      'translation',
    );

    expect(conversation.conversationType).toBe('translation');
    expect(conversation.messages).toEqual([]);
    expect(conversation.model.id).toBe('gpt-5');
    expect(conversation.workflowState).toBeUndefined();
  });

  it('attaches the initial workflow state when provided', () => {
    const initial: TranslationWorkflowState = {
      kind: 'translation',
      sourceText: '',
      mode: 'agentic',
      rounds: [],
      updatedAt: '2026-07-09T00:00:00.000Z',
    };

    const conversation = createWorkflowConversation(
      models,
      undefined,
      '',
      0.5,
      'translation',
      initial,
    );

    expect(conversation.workflowState).toEqual(initial);
  });

  it('inherits default-conversation behavior for model fallback', () => {
    const byHelper = createWorkflowConversation(
      models,
      'missing-model',
      '',
      0.5,
      'map',
    );
    const byDefault = createDefaultConversation(
      models,
      'missing-model',
      '',
      0.5,
    );

    expect(byHelper.model.id).toBe(byDefault.model.id);
  });
});
