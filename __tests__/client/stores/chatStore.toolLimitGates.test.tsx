/**
 * Regression coverage for docs/LIMITS_USER_FACING_UX.md §7.4/§3c's
 * request-time rule: a feature the composer shows as locked/Off must also
 * go out as Off on the wire. `sendChatRequest` reads the latest gates via
 * `getToolLimitGatesSnapshot()` (published by whichever composer surface —
 * ToolModeControls / Dropdown / ConnectorPinTray — is mounted) and applies
 * `effectiveSearchMode` / `effectiveInterpreterMode` / an MCP-list clear
 * before building the request. Before this fix the store sent the raw
 * composer value regardless, so a blocked account 403'd on every message
 * even though every surface showed the control as Off.
 */
import * as toolLimitGates from '@/client/hooks/settings/useAgentToolGates';

import { Conversation, MessageType } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';
import { SearchMode } from '@/types/searchMode';

import { chatService } from '@/client/services';
import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useChatStore } from '@/client/stores/chatStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const OPEN_GATE = { blocked: false, exhausted: false, low: false };
const BLOCKED_GATE = { blocked: true, exhausted: false, low: false };

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

describe('chatStore applies admin usage-limit tool gates at request time', () => {
  let chatSpy: ReturnType<typeof vi.spyOn>;
  let snapshotSpy: ReturnType<typeof vi.spyOn>;

  const sentOptions = () => chatSpy.mock.calls[0][2] as Record<string, unknown>;

  beforeEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({
      mcpServers: [githubServer],
      allowArbitraryMcpServers: false,
      mcpArbitraryFlagEnabled: false,
    });
    useChatInputStore.setState({ interpreterMode: InterpreterMode.ALWAYS });
    chatSpy = vi
      .spyOn(chatService, 'chat')
      .mockResolvedValue(new ReadableStream());
    snapshotSpy = vi.spyOn(toolLimitGates, 'getToolLimitGatesSnapshot');
  });

  afterEach(() => {
    useChatInputStore.setState({ interpreterMode: InterpreterMode.OFF });
  });

  it('forces search/interpreter Off and drops every MCP server while every gate is blocked', async () => {
    snapshotSpy.mockReturnValue({
      webSearch: BLOCKED_GATE,
      codeInterpreter: BLOCKED_GATE,
      mcp: BLOCKED_GATE,
      m365: BLOCKED_GATE,
      enforce: true,
    });

    await useChatStore
      .getState()
      .sendChatRequest(makeConversation(), SearchMode.ALWAYS);

    const options = sentOptions();
    expect(options.searchMode).toBe(SearchMode.OFF);
    expect(options.webSearchOptions).toBeUndefined();
    expect(options.interpreterMode).toBe(InterpreterMode.OFF);
    expect(options.mcpServers).toBeUndefined();
  });

  it('blocking only webSearch leaves the interpreter and MCP servers untouched', async () => {
    snapshotSpy.mockReturnValue({
      webSearch: BLOCKED_GATE,
      codeInterpreter: OPEN_GATE,
      mcp: OPEN_GATE,
      m365: OPEN_GATE,
      enforce: true,
    });

    await useChatStore
      .getState()
      .sendChatRequest(makeConversation(), SearchMode.INTELLIGENT);

    const options = sentOptions();
    expect(options.searchMode).toBe(SearchMode.OFF);
    expect(options.interpreterMode).toBe(InterpreterMode.ALWAYS);
    expect(options.mcpServers).toEqual([
      expect.objectContaining({ id: 'github' }),
    ]);
  });

  it("passes every mode through unchanged while gates are open (today's behavior)", async () => {
    snapshotSpy.mockReturnValue({
      webSearch: OPEN_GATE,
      codeInterpreter: OPEN_GATE,
      mcp: OPEN_GATE,
      m365: OPEN_GATE,
      enforce: false,
    });

    await useChatStore
      .getState()
      .sendChatRequest(makeConversation(), SearchMode.ALWAYS);

    const options = sentOptions();
    expect(options.searchMode).toBe(SearchMode.ALWAYS);
    expect(options.interpreterMode).toBe(InterpreterMode.ALWAYS);
    expect(options.mcpServers).toEqual([
      expect.objectContaining({ id: 'github' }),
    ]);
  });

  it('fails open before any composer surface has published a snapshot', async () => {
    // getToolLimitGatesSnapshot's own contract: OPEN_GATES until a mounted
    // surface (ToolModeControls/Dropdown/ConnectorPinTray) has rendered.
    snapshotSpy.mockRestore();

    await useChatStore
      .getState()
      .sendChatRequest(makeConversation(), SearchMode.ALWAYS);

    const options = sentOptions();
    expect(options.searchMode).toBe(SearchMode.ALWAYS);
    expect(options.interpreterMode).toBe(InterpreterMode.ALWAYS);
    expect(options.mcpServers).toEqual([
      expect.objectContaining({ id: 'github' }),
    ]);
  });
});
