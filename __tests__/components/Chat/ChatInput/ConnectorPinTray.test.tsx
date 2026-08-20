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

// The agent section pulls the discovered-agent list (React Query + LD flags
// underneath) — stub it so the connector rows under test render standalone.
vi.mock('@/client/hooks/settings/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ agents: [], isLoading: false }),
  findAttachedAgent: () => undefined,
}));

vi.mock('@/client/hooks/settings/useSettings', () => ({
  useSettings: () => ({ models: [], defaultModelId: undefined }),
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

  it('the row checkbox disables the server for THIS chat only', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    render(<ConnectorPinTray />);

    fireEvent.click(within(rowFor('GitHub')).getByRole('checkbox'));

    // Global config untouched; the opt-out lands on the conversation.
    expect(
      useSettingsStore.getState().mcpServers.find((s) => s.id === 's1')
        ?.enabled,
    ).toBe(true);
    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      disabledMcpServerIds: ['s1'],
    });
  });

  it('re-checking removes the per-chat opt-out', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    selectedConversation = { id: 'conv-1', disabledMcpServerIds: ['s1'] };
    render(<ConnectorPinTray />);

    const checkbox = within(rowFor('GitHub')).getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      disabledMcpServerIds: [],
    });
  });

  it('the global button flips the server everywhere and revives a disabled one', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: false, authMode: 'none' },
    ]);
    render(<ConnectorPinTray />);

    // Chat checkbox is inert while globally off.
    expect(within(rowFor('GitHub')).getByRole('checkbox')).toBeDisabled();

    fireEvent.click(within(rowFor('GitHub')).getByText('Global off'));
    expect(
      useSettingsStore.getState().mcpServers.find((s) => s.id === 's1')
        ?.enabled,
    ).toBe(true);
  });

  it('a chat-disabled server is not focusable', () => {
    setServers([{ id: 's1', name: 'GitHub', enabled: true, authMode: 'none' }]);
    selectedConversation = { id: 'conv-1', disabledMcpServerIds: ['s1'] };
    render(<ConnectorPinTray />);

    expect(within(rowFor('GitHub')).queryByText('Focus')).toBeNull();
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

  it('auto-hides when every connector is opted out for this chat', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: true, authMode: 'none' },
      { id: 's2', name: 'NetSuite', enabled: true, authMode: 'none' },
    ]);
    selectedConversation = {
      id: 'conv-1',
      disabledMcpServerIds: ['s1', 's2'],
    };
    const { container } = render(<ConnectorActivityBadge />);

    expect(container).toBeEmptyDOMElement();
  });

  it('counts only chat-active connectors', () => {
    setServers([
      { id: 's1', name: 'GitHub', enabled: true, authMode: 'none' },
      { id: 's2', name: 'NetSuite', enabled: true, authMode: 'none' },
    ]);
    selectedConversation = { id: 'conv-1', disabledMcpServerIds: ['s1'] };
    render(<ConnectorActivityBadge />);

    // Only NetSuite is active for this chat → its name, not "2 tools".
    expect(screen.getByText('NetSuite')).toBeInTheDocument();
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

describe('ConnectorPinTray — virtual Microsoft 365 row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedConversation = { id: 'conv-1' };
    setServers([]);
    useChatInputStore.setState({ connectorPinTrayOpen: true });
    // jsdom runs on localhost, so useM365Enabled().toolsEnabled is true via
    // the documented localhost escape hatch — only the store gates remain.
    useSettingsStore.setState({
      m365Connected: true,
      m365ToolsUserEnabled: true,
    });
  });

  it('renders the row when M365 is connected, even with no configured servers', () => {
    render(<ConnectorPinTray />);
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
  });

  it('hides the row when M365 is not connected', () => {
    useSettingsStore.setState({ m365Connected: false });
    render(<ConnectorPinTray />);
    expect(screen.queryByText('Microsoft 365')).not.toBeInTheDocument();
  });

  it('per-chat checkbox writes builtin-m365 into disabledMcpServerIds', () => {
    render(<ConnectorPinTray />);
    fireEvent.click(within(rowFor('Microsoft 365')).getByRole('checkbox'));
    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      disabledMcpServerIds: ['builtin-m365'],
    });
  });

  it('global toggle flips m365ToolsUserEnabled and dims the chat checkbox', () => {
    render(<ConnectorPinTray />);
    const row = rowFor('Microsoft 365');
    fireEvent.click(within(row).getByText('Global on'));
    expect(useSettingsStore.getState().m365ToolsUserEnabled).toBe(false);
  });

  it('chat checkbox is disabled while the global toggle is off', () => {
    useSettingsStore.setState({ m365ToolsUserEnabled: false });
    render(<ConnectorPinTray />);
    expect(
      within(rowFor('Microsoft 365')).getByRole('checkbox'),
    ).toBeDisabled();
  });

  it('focus action pins builtin-m365 on the conversation', () => {
    render(<ConnectorPinTray />);
    fireEvent.click(within(rowFor('Microsoft 365')).getByText('Focus'));
    expect(updateConversation).toHaveBeenCalledWith('conv-1', {
      pinnedMcpServerId: 'builtin-m365',
    });
  });
});

describe('ConnectorActivityBadge — builtin Microsoft 365', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedConversation = { id: 'conv-1' };
    setServers([]);
    useSettingsStore.setState({
      m365Connected: true,
      m365ToolsUserEnabled: true,
    });
  });

  it('counts the toolset active and names it when it is the only one', () => {
    render(<ConnectorActivityBadge />);
    expect(screen.getByText('Microsoft 365')).toBeInTheDocument();
  });

  it('renders nothing when the conversation disabled it per-chat', () => {
    selectedConversation = {
      id: 'conv-1',
      disabledMcpServerIds: ['builtin-m365'],
    };
    const { container } = render(<ConnectorActivityBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the global toolset toggle is off', () => {
    useSettingsStore.setState({ m365ToolsUserEnabled: false });
    const { container } = render(<ConnectorActivityBadge />);
    expect(container).toBeEmptyDOMElement();
  });
});
