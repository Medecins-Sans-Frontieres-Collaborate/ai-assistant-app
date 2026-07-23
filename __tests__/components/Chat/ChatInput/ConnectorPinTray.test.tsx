import { fireEvent, render, screen, within } from '@testing-library/react';

import type { Conversation } from '@/types/chat';

import { ConnectorActivityBadge } from '@/components/Chat/ChatInput/ConnectorActivityBadge';
import { ConnectorPinTray } from '@/components/Chat/ChatInput/ConnectorPinTray';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';
import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateConversation = vi.fn();
let selectedConversation: Partial<Conversation> | null;

vi.mock('@/client/hooks/conversation/useConversations', () => ({
  useConversations: () => ({
    selectedConversation,
    updateConversation,
  }),
}));

type TestServer = {
  id: string;
  name: string;
  enabled: boolean;
  authMode: 'none' | 'bearer' | 'oauth';
  oauth?: { needsReauth?: boolean };
};

function setServers(servers: TestServer[]) {
  useSettingsStore.setState({
    mcpServers: servers as unknown as ReturnType<
      typeof useSettingsStore.getState
    >['mcpServers'],
  });
}

function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe('ConnectorPinTray', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedConversation = { id: 'conv-1' };
    setServers([]);
    useChatInputStore.setState({ connectorPinTrayOpen: true });
  });

  it('lists every configured server with its enabled state', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: true, authMode: 'oauth' },
      { id: 's2', name: 'Disabled', enabled: false, authMode: 'bearer' },
    ]);
    render(<ConnectorPinTray />);

    expect(within(rowFor('GitHub')).getByRole('checkbox')).toBeChecked();
    expect(within(rowFor('Disabled')).getByRole('checkbox')).not.toBeChecked();
  });

  it('toggling a row flips the server in settings', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    render(<ConnectorPinTray />);

    fireEvent.click(within(rowFor('GitHub')).getByRole('checkbox'));

    expect(
      useSettingsStore.getState().mcpServers.find((s) => s.id === 's1')
        ?.enabled,
    ).toBe(false);
  });

  it('focuses a usable server from its row', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: true, authMode: 'oauth' },
      { id: 's2', name: 'NetSuite', enabled: true, authMode: 'oauth' },
    ]);
    render(<ConnectorPinTray />);

    fireEvent.click(within(rowFor('NetSuite')).getByText('Focus'));

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      pinnedMcpServerId: 's2',
    });
  });

  it('offers no Focus on disabled or reauth-needed servers', () => {
    // A needs-reauth connector would contribute zero tools — offering it as
    // a "focus" would be a lie.
    setServers([
      { id: 's1', name: 'Off', enabled: false, authMode: 'bearer' },
      {
        id: 's2',
        name: 'Expired',
        enabled: true,
        authMode: 'oauth',
        oauth: { needsReauth: true },
      },
    ]);
    render(<ConnectorPinTray />);

    expect(screen.queryByText('Focus')).not.toBeInTheDocument();
    expect(
      within(rowFor('Expired')).getByText('Reconnect in Settings'),
    ).toBeInTheDocument();
  });

  it('shows the focused server and unpins from its chip', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    selectedConversation = { id: 'conv-1', pinnedMcpServerId: 's1' };
    render(<ConnectorPinTray />);

    expect(screen.getByText(/Only tools from GitHub/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Focused'));

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      pinnedMcpServerId: undefined,
    });
  });

  it('flags a stale pin instead of pretending the focus still applies', () => {
    // The send path fails open on a stale pin (all tools go through), so
    // the tray must say that rather than claim the focus is active.
    setServers([
      { id: 's1', name: 'GitHub', enabled: false, authMode: 'none' },
    ]);
    selectedConversation = { id: 'conv-1', pinnedMcpServerId: 's1' };
    render(<ConnectorPinTray />);

    expect(screen.getByText(/disconnected or disabled/)).toBeInTheDocument();
  });

  it('spells out the token/latency cost when nothing is focused', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    render(<ConnectorPinTray />);

    expect(screen.getByText(/more tokens and slower/)).toBeInTheDocument();
  });

  it('explains when nothing is configured yet', () => {
    render(<ConnectorPinTray />);

    expect(screen.getByText(/No connectors configured/)).toBeInTheDocument();
  });
});

describe('ConnectorActivityBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedConversation = { id: 'conv-1' };
    setServers([]);
    useChatInputStore.setState({ connectorPinTrayOpen: false });
  });

  it('renders nothing while no connector is active', () => {
    setServers([
      { id: 's1', name: 'Off', enabled: false, authMode: 'bearer' },
      {
        id: 's2',
        name: 'Expired',
        enabled: true,
        authMode: 'oauth',
        oauth: { needsReauth: true },
      },
    ]);
    const { container } = render(<ConnectorActivityBadge />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the active count and opens the tray on click', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: true, authMode: 'oauth' },
      { id: 's2', name: 'NetSuite', enabled: true, authMode: 'none' },
    ]);
    render(<ConnectorActivityBadge />);

    fireEvent.click(screen.getByText('2 tools'));

    expect(useChatInputStore.getState().connectorPinTrayOpen).toBe(true);
  });

  it('names a single active connector instead of "1 tools"', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: true, authMode: 'oauth' },
    ]);
    render(<ConnectorActivityBadge />);

    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.queryByText(/1 tools/)).not.toBeInTheDocument();
  });

  it('names the focused connector instead of a count', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: true, authMode: 'oauth' },
      { id: 's2', name: 'NetSuite', enabled: true, authMode: 'none' },
    ]);
    selectedConversation = { id: 'conv-1', pinnedMcpServerId: 's2' };
    render(<ConnectorActivityBadge />);

    expect(screen.getByText('NetSuite')).toBeInTheDocument();
    expect(screen.queryByText('2 tools')).not.toBeInTheDocument();
  });
});
