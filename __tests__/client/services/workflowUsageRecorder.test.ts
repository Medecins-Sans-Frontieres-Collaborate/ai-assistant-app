/**
 * The single client entry point for workflow token spend
 * (docs/WORKFLOW_EMISSIONS_DESIGN.md §4c). Three transports converge here, so
 * what it refuses matters as much as what it records.
 */
import { recordWorkflowUsage } from '@/client/services/workflows/workflowUsageRecorder';

import { useConversationStore } from '@/client/stores/conversationStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordTokenUsage = vi.fn();
const recordWorkflowTypeUsage = vi.fn();
const recordWorkflowRunUsage = vi.fn();

vi.mock('@/client/stores/settingsStore', () => ({
  useSettingsStore: { getState: vi.fn() },
}));
vi.mock('@/client/stores/conversationStore', () => ({
  useConversationStore: { getState: vi.fn() },
}));

const conversation = {
  id: 'conv-1',
  conversationType: 'translation',
  workflowState: {
    kind: 'translation',
    sourceText: 'x',
    mode: 'agentic',
    rounds: [],
    targetLanguage: { id: 'ps', label: 'Pashto' },
    updatedAt: '',
  },
};

const payload = {
  action: 'translate:agentic',
  region: null,
  promptTokens: 300,
  completionTokens: 150,
  totalTokens: 450,
  calls: [
    {
      label: 'analysis',
      modelId: 'gpt-5.2',
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    },
    {
      label: 'translate',
      modelId: 'gpt-5.2',
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
    },
  ],
};

describe('recordWorkflowUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettingsStore.getState).mockReturnValue({
      recordTokenUsage,
      recordWorkflowTypeUsage,
    } as never);
    vi.mocked(useConversationStore.getState).mockReturnValue({
      conversations: [conversation],
      recordWorkflowRunUsage,
    } as never);
  });

  it('buckets each call by its SERVED model, as chat does', () => {
    recordWorkflowUsage('conv-1', payload);

    expect(recordTokenUsage).toHaveBeenCalledTimes(2);
    expect(recordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gpt-5.2', promptTokens: 100 }),
    );
  });

  it('stamps the run with the current artifact and its label', () => {
    recordWorkflowUsage('conv-1', payload);

    const run = recordWorkflowRunUsage.mock.calls[0][1];
    expect(run.artifactId).toBe('lang:ps');
    expect(run.artifactLabel).toBe('Pashto');
    expect(run.calls).toBe(2);
    expect(run.byLabel).toEqual([
      { label: 'analysis', promptTokens: 100, completionTokens: 50 },
      { label: 'translate', promptTokens: 200, completionTokens: 100 },
    ]);
  });

  it('records the per-workflow-type split as a SUBSET, once per run', () => {
    recordWorkflowUsage('conv-1', payload);

    expect(recordWorkflowTypeUsage).toHaveBeenCalledTimes(1);
    expect(recordWorkflowTypeUsage).toHaveBeenCalledWith('translation', {
      promptTokens: 300,
      completionTokens: 150,
    });
  });

  it('ignores a malformed or empty payload rather than recording a zero run', () => {
    recordWorkflowUsage('conv-1', undefined);
    recordWorkflowUsage('conv-1', { action: 'x' });
    recordWorkflowUsage('conv-1', { ...payload, calls: [] });
    recordWorkflowUsage('conv-1', {
      ...payload,
      promptTokens: 0,
      completionTokens: 0,
    });

    expect(recordTokenUsage).not.toHaveBeenCalled();
    expect(recordWorkflowRunUsage).not.toHaveBeenCalled();
  });

  it('still counts the account total when the conversation is gone', () => {
    vi.mocked(useConversationStore.getState).mockReturnValue({
      conversations: [],
      recordWorkflowRunUsage,
    } as never);

    recordWorkflowUsage('conv-1', payload);

    expect(recordTokenUsage).toHaveBeenCalledTimes(2);
    expect(recordWorkflowRunUsage).not.toHaveBeenCalled();
  });
});
