import { Conversation, MessageType } from '@/types/chat';

import { chatService } from '@/client/services';
import { useChatStore } from '@/client/stores/chatStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeConversation(overrides?: Partial<Conversation>): Conversation {
  return {
    id: 'conv-1',
    name: 'test',
    messages: [
      { role: 'user', content: 'hello', messageType: MessageType.TEXT },
    ],
    model: { id: 'gpt-5.2', name: 'GPT-5.2' } as never,
    prompt: '',
    temperature: 0.5,
    folderId: null,
    ...overrides,
  };
}

const githubServer = {
  id: 'github',
  catalogKey: 'github',
  name: 'GitHub',
  url: '',
  authMode: 'bearer' as const,
  authToken: 'github_pat_x',
  enabled: true,
  createdAt: 'now',
};
const disabledServer = {
  ...githubServer,
  id: 'asana',
  catalogKey: 'asana',
  enabled: false,
};
const tokenlessCurated = {
  ...githubServer,
  id: 'asana2',
  catalogKey: 'asana',
  authToken: undefined,
};
const arbitraryServer = {
  id: 'c1',
  name: 'Mine',
  url: 'https://mcp.example.com',
  authMode: 'none' as const,
  enabled: true,
  createdAt: 'now',
};

describe('chatStore MCP wiring', () => {
  let chatSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
      mcpServers: [],
      allowArbitraryMcpServers: false,
      mcpArbitraryFlagEnabled: false,
    });
    chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream());
  });

  const sentOptions = () => chatSpy.mock.calls[0][2] as Record<string, unknown>;

  it('sends enabled curated servers (no url — the server resolves it)', async () => {
    useSettingsStore.setState({
      mcpServers: [githubServer, disabledServer, tokenlessCurated],
    });

    await useChatStore.getState().sendChatRequest(makeConversation());

    expect(sentOptions().mcpServers).toEqual([
      {
        id: 'github',
        name: 'GitHub',
        url: undefined,
        authToken: 'github_pat_x',
        catalogKey: 'github',
      },
    ]);
  });

  it('drops arbitrary servers unless BOTH the user toggle and LD flag mirror are on', async () => {
    useSettingsStore.setState({ mcpServers: [arbitraryServer] });

    await useChatStore.getState().sendChatRequest(makeConversation());
    expect(sentOptions().mcpServers).toBeUndefined();

    chatSpy.mockClear();
    useSettingsStore.setState({
      allowArbitraryMcpServers: true,
      mcpArbitraryFlagEnabled: false,
    });
    await useChatStore.getState().sendChatRequest(makeConversation());
    expect(sentOptions().mcpServers).toBeUndefined();

    chatSpy.mockClear();
    useSettingsStore.setState({ mcpArbitraryFlagEnabled: true });
    await useChatStore.getState().sendChatRequest(makeConversation());
    expect(sentOptions().mcpServers).toEqual([
      {
        id: 'c1',
        name: 'Mine',
        url: 'https://mcp.example.com',
        authToken: undefined,
        catalogKey: undefined,
      },
    ]);
  });

  it('never sends MCP servers on agent invocations', async () => {
    useSettingsStore.setState({ mcpServers: [githubServer] });

    await useChatStore.getState().sendChatRequest(
      makeConversation({
        model: {
          id: 'org-hr-bot',
          name: 'HR Bot',
          isOrganizationAgent: true,
        } as never,
      }),
    );

    expect(sentOptions().mcpServers).toBeUndefined();
  });

  it('native-MCP resume sends the full transcript + pending calls rebuilt from consents', async () => {
    useSettingsStore.setState({ mcpServers: [githubServer] });
    const conversation = makeConversation({
      messages: [
        { role: 'user', content: 'list my PRs', messageType: MessageType.TEXT },
        {
          role: 'assistant',
          content: 'Let me check.',
          messageType: MessageType.TEXT,
          consentRequests: [
            {
              kind: 'approval',
              approval_request_id: 'call_1',
              server_id: 'github',
              server_label: 'GitHub',
              tool_name: 'list_prs',
              tool_arguments: '{"repo":"a/b"}',
            },
          ],
        } as never,
      ],
    });

    await useChatStore
      .getState()
      .sendChatRequest(conversation, undefined, [
        { approval_request_id: 'call_1', approve: true },
      ]);

    const options = sentOptions();
    expect(options.mcpPendingToolCalls).toEqual([
      {
        id: 'call_1',
        serverId: 'github',
        toolName: 'list_prs',
        argumentsJson: '{"repo":"a/b"}',
      },
    ]);
    expect(options.mcpLoopRound).toBe(1);
    // Full transcript, not the Foundry slice(-1) shortcut.
    const messages = chatSpy.mock.calls[0][1] as Array<{ role: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('user');
  });

  it('Foundry-style resume (no server_id on consents) keeps the slice(-1) behavior', async () => {
    const conversation = makeConversation({
      messages: [
        { role: 'user', content: 'do it', messageType: MessageType.TEXT },
        {
          role: 'assistant',
          content: 'Needs approval.',
          messageType: MessageType.TEXT,
          consentRequests: [
            {
              kind: 'approval',
              approval_request_id: 'foundry_1',
              tool_name: 'do_thing',
            },
          ],
        } as never,
      ],
    });

    await useChatStore
      .getState()
      .sendChatRequest(conversation, undefined, [
        { approval_request_id: 'foundry_1', approve: true },
      ]);

    const options = sentOptions();
    expect(options.mcpPendingToolCalls).toBeUndefined();
    const messages = chatSpy.mock.calls[0][1] as Array<{ role: string }>;
    expect(messages.length).toBe(1);
  });
  it('oauth servers send their (fresh) access token as authToken', async () => {
    useSettingsStore.setState({
      mcpServers: [
        {
          id: 'asana',
          catalogKey: 'asana',
          name: 'Asana',
          url: '',
          authMode: 'oauth' as const,
          oauth: {
            clientId: 'dcr-1',
            accessToken: 'at-live',
            expiresAt: Date.now() + 3_600_000,
          },
          enabled: true,
          createdAt: 'now',
        },
      ],
    });

    await useChatStore.getState().sendChatRequest(makeConversation());

    expect(sentOptions().mcpServers).toEqual([
      {
        id: 'asana',
        name: 'Asana',
        url: undefined,
        authToken: 'at-live',
        catalogKey: 'asana',
      },
    ]);
  });

  it('oauth servers needing reauth are EXCLUDED from the request', async () => {
    useSettingsStore.setState({
      mcpServers: [
        {
          id: 'asana',
          catalogKey: 'asana',
          name: 'Asana',
          url: '',
          authMode: 'oauth' as const,
          oauth: { clientId: 'dcr-1', needsReauth: true },
          enabled: true,
          createdAt: 'now',
        },
      ],
    });

    await useChatStore.getState().sendChatRequest(makeConversation());

    expect(sentOptions().mcpServers).toBeUndefined();
  });
});
