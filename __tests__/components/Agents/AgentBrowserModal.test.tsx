import { fireEvent, render, screen, within } from '@testing-library/react';

import type { AvailableAgent } from '@/lib/utils/app/agentAttachment';

import type { Conversation } from '@/types/chat';

import { AgentBrowserModal } from '@/components/Agents/AgentBrowserModal';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateConversation = vi.fn();
const addConversation = vi.fn();
const selectConversation = vi.fn();
let selectedConversation: Partial<Conversation> | null;

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({
    conversations: [],
    selectedConversation,
    addConversation,
    selectConversation,
    updateConversation,
  }),
}));

const AGENTS: AvailableAgent[] = [
  { id: 'orgr-alpha', botId: 'orgr-alpha', name: 'Alpha Agent', kind: 'org' },
  {
    id: 'prompt-beta',
    botId: 'prompt-beta',
    name: 'Beta Persona',
    kind: 'prompt',
  },
];

const availableState = vi.hoisted(() => ({
  isError: false,
  retry: vi.fn(),
  empty: false,
}));

vi.mock('@/client/hooks/settings/useAvailableAgents', () => ({
  useAvailableAgents: () => ({
    agents: availableState.empty ? [] : AGENTS,
    isLoading: false,
    isError: availableState.isError,
    retry: availableState.retry,
  }),
  findAttachedAgent: (
    agents: AvailableAgent[],
    conv: { bot?: string } | null,
  ) => agents.find((a) => a.botId === conv?.bot),
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({
    models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }],
    defaultModelId: 'gpt-5.2',
    systemPrompt: '',
    temperature: 0.5,
    defaultSearchMode: undefined,
    defaultInterpreterMode: undefined,
  }),
}));

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ toolsEnabled: false }),
}));

function setServers(servers: unknown[]) {
  useSettingsStore.setState({
    mcpServers: servers as ReturnType<
      typeof useSettingsStore.getState
    >['mcpServers'],
  });
}

describe('AgentBrowserModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availableState.isError = false;
    availableState.empty = false;
    selectedConversation = { id: 'conv-1', model: { id: 'gpt-5.2' } } as never;
    setServers([]);
    useSettingsStore.setState({ agentBrowserUsage: {} });
    useUIStore.setState({ agentBrowserOpen: true });
  });

  it('explains a failed discovery and offers Retry instead of "No agents"', () => {
    availableState.isError = true;
    availableState.empty = true;
    render(<AgentBrowserModal />);
    expect(
      screen.getByText(/Your agents couldn't be loaded just now/),
    ).toBeInTheDocument();
    expect(screen.queryByText('No agents available.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(availableState.retry).toHaveBeenCalledTimes(1);
  });

  it('lists agents and connectors together, kind-labelled', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    render(<AgentBrowserModal />);

    expect(screen.getByText('Alpha Agent')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('Connector')).toBeInTheDocument();
    expect(screen.getAllByText(/Knowledge|Persona/).length).toBeGreaterThan(0);
  });

  it('orders by usage with the default order as tiebreaker', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    useSettingsStore.setState({
      agentBrowserUsage: { 'connector-s1': 5, 'prompt-beta': 2 },
    });
    render(<AgentBrowserModal />);

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('GitHub');
    expect(options[1]).toHaveTextContent('Beta Persona');
    expect(options[2]).toHaveTextContent('Alpha Agent');
  });

  it('"Add to this chat" is the primary action and attaches without creating a chat', () => {
    render(<AgentBrowserModal />);

    fireEvent.click(screen.getAllByText('Add to this chat')[0]);

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      bot: 'orgr-alpha',
    });
    expect(addConversation).not.toHaveBeenCalled();
  });

  it('ArrowDown + Enter attaches the highlighted row', () => {
    const input = () => screen.getByRole('combobox');
    render(<AgentBrowserModal />);

    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      bot: 'prompt-beta',
    });
  });

  it('Escape clears the query first, then closes', () => {
    render(<AgentBrowserModal />);
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect((input as HTMLInputElement).value).toBe('');
    expect(useUIStore.getState().agentBrowserOpen).toBe(true);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useUIStore.getState().agentBrowserOpen).toBe(false);
  });

  it('Enter on a connector row toggles it on for this chat and records usage', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    selectedConversation = {
      id: 'conv-1',
      model: { id: 'gpt-5.2' },
      disabledMcpServerIds: ['s1'],
    } as never;
    const input = () => screen.getByRole('combobox');
    render(<AgentBrowserModal />);

    fireEvent.change(input(), { target: { value: 'github' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      disabledMcpServerIds: [],
    });
    expect(useSettingsStore.getState().agentBrowserUsage['connector-s1']).toBe(
      1,
    );
  });

  it('enabling a globally-off connector revives it globally in one click', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: false, authMode: 'none' },
    ]);
    render(<AgentBrowserModal />);

    const row = screen.getByText('GitHub').closest('li') as HTMLElement;
    fireEvent.click(within(row).getByText('Add to this chat'));

    expect(
      useSettingsStore.getState().mcpServers.find((s) => s.id === 's1')
        ?.enabled,
    ).toBe(true);
  });

  it('an active connector offers removal instead', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    render(<AgentBrowserModal />);

    fireEvent.click(screen.getByText('Remove from this chat'));

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      disabledMcpServerIds: ['s1'],
    });
  });

  it('with no conversation, New chat is the agents-only fallback and connectors offer no action', () => {
    selectedConversation = null;
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    render(<AgentBrowserModal />);

    expect(screen.queryByText('Add to this chat')).toBeNull();
    expect(screen.queryByText('Remove from this chat')).toBeNull();
    fireEvent.click(screen.getAllByText('New chat')[0]);
    expect(addConversation).toHaveBeenCalled();
  });
});
