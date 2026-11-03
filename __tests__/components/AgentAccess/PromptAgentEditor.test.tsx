import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OpenAIModelID, OpenAIModels } from '@/types/openai';

import { PromptAgentEditor } from '@/components/AgentAccess/PromptAgentEditor';
import type { AdminStoredPromptAgent } from '@/components/AgentAccess/types';

import { PROMPT_AGENT_MAX_PROMPT_CHARS } from '@/lib/constants/promptAgents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn() },
}));
vi.mock('@/client/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      models: [OpenAIModels[OpenAIModelID.GPT_5_2_CHAT]],
      userRegion: 'US',
    }),
}));

const existing: AdminStoredPromptAgent = {
  canonicalKey: 'prompt-agent::prompt-abc123def456',
  etag: '"etag-1"',
  agent: {
    version: 1,
    id: 'prompt-abc123def456',
    name: 'Brand checker',
    description: 'Reviews communications',
    systemPrompt: 'Original prompt',
    modelId: OpenAIModelID.GPT_5_2_CHAT,
    createdBy: 'admin@example.org',
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-11-03T00:00:00.000Z',
  },
};

describe('PromptAgentEditor prompt length', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { length: 48_082, method: 'POST' },
    { length: 48_082, method: 'PUT' },
    { length: PROMPT_AGENT_MAX_PROMPT_CHARS, method: 'POST' },
    { length: PROMPT_AGENT_MAX_PROMPT_CHARS, method: 'PUT' },
  ])(
    '$method retains and submits all $length characters',
    async ({ length, method }) => {
      const onSaved = vi.fn();
      render(
        <PromptAgentEditor
          existing={method === 'POST' ? null : existing}
          onSaved={onSaved}
          onCancel={vi.fn()}
          onConflictReload={vi.fn()}
        />,
      );
      const input = screen.getByLabelText('agentSystemPromptLabel');
      const systemPrompt = 'x'.repeat(length - 4) + '\nEND';

      if (method === 'POST') {
        fireEvent.change(screen.getByLabelText('agentNameLabel'), {
          target: { value: 'Brand checker' },
        });
        fireEvent.change(screen.getByLabelText('agentModelLabel'), {
          target: { value: OpenAIModelID.GPT_5_2_CHAT },
        });
      }
      expect(input).toHaveAttribute(
        'maxlength',
        String(PROMPT_AGENT_MAX_PROMPT_CHARS),
      );
      fireEvent.change(input, { target: { value: systemPrompt } });
      expect(input).toHaveValue(systemPrompt);
      fireEvent.click(screen.getByRole('button', { name: 'save' }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      const [, request] = fetchMock.mock.calls[0];
      expect(request.method).toBe(method);
      expect(JSON.parse(request.body).systemPrompt).toBe(systemPrompt);
    },
  );

  it('disables save for an over-limit stored prompt without truncating it', () => {
    const systemPrompt = 'x'.repeat(PROMPT_AGENT_MAX_PROMPT_CHARS + 1);
    render(
      <PromptAgentEditor
        existing={{ ...existing, agent: { ...existing.agent, systemPrompt } }}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
        onConflictReload={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('agentSystemPromptLabel')).toHaveValue(
      systemPrompt,
    );
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
