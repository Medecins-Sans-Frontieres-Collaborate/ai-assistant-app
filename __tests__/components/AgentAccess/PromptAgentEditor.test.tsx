import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';

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

/** Renders the real skills query with an isolated cache, as the app does. */
function renderEditor(props: ComponentProps<typeof PromptAgentEditor>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PromptAgentEditor {...props} />
    </QueryClientProvider>,
  );
}

describe('PromptAgentEditor prompt length', () => {
  const fetchMock =
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url, init) => {
      if (url === '/api/agent-access/skills' && !init?.method) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { skills: [], skillsUnavailable: false, fetchedAt: 1 },
          }),
          { status: 200 },
        );
      }
      if (
        url === '/api/agent-access/prompt-agents' &&
        (init?.method === 'POST' || init?.method === 'PUT')
      ) {
        return new Response('{}', { status: 200 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
    });
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
      renderEditor({
        existing: method === 'POST' ? null : existing,
        onSaved,
        onCancel: vi.fn(),
        onConflictReload: vi.fn(),
      });
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
      const writes = fetchMock.mock.calls.filter(
        ([url]) => url === '/api/agent-access/prompt-agents',
      );
      expect(writes).toHaveLength(1);
      const [, request] = writes[0];
      expect(request?.method).toBe(method);
      expect(JSON.parse(request?.body as string).systemPrompt).toBe(
        systemPrompt,
      );
    },
  );

  it('disables save for an over-limit stored prompt without truncating it', () => {
    const systemPrompt = 'x'.repeat(PROMPT_AGENT_MAX_PROMPT_CHARS + 1);
    renderEditor({
      existing: { ...existing, agent: { ...existing.agent, systemPrompt } },
      onSaved: vi.fn(),
      onCancel: vi.fn(),
      onConflictReload: vi.fn(),
    });

    expect(screen.getByLabelText('agentSystemPromptLabel')).toHaveValue(
      systemPrompt,
    );
    expect(screen.getByRole('button', { name: 'save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === '/api/agent-access/prompt-agents',
      ),
    ).toHaveLength(0);
  });
});
