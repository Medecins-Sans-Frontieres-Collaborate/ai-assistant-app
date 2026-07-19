import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { ConnectorsSection } from '@/components/Settings/Sections/ConnectorsSection';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable LD flags (mirrors ModelSelect test pattern).
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

// useMcpTools hits React Query + fetch; the rows only need a tool list.
vi.mock('@/client/hooks/settings/useMcpTools', () => ({
  useMcpTools: () => ({ tools: [], isLoadingTools: false, toolsError: false }),
}));

// Deployment OAuth-app availability (also React Query + fetch). Defaults to
// "configured" — the unavailable cases set entries explicitly.
const mockOauthAvailability: Record<string, boolean> = {};
vi.mock('@/client/hooks/settings/useMcpOauthAvailability', () => ({
  useMcpOauthAvailability: () => ({
    isOauthAppAvailable: (key: string) => mockOauthAvailability[key] !== false,
  }),
}));

// Admin-authored connectors (React Query + fetch). Empty by default so the
// curated-catalog cases are unaffected; the connector cases push entries in.
const mockAdminConnectors: {
  id: string;
  name: string;
  description: string;
  authStyle: 'none' | 'bearer' | 'oauth';
  tokenHelpUrl?: string;
  oauthAppConfigured: boolean;
}[] = [];
vi.mock('@/client/hooks/settings/useAvailableConnectors', () => ({
  useAvailableConnectors: () => ({
    connectors: mockAdminConnectors,
    isLoadingConnectors: false,
  }),
}));

/**
 * The section now lists available connectors compactly; the configuration UI
 * appears only after the user adds one. Tests that exercise connect
 * affordances go through this gesture first, exactly as a user does.
 */
function addConnector(name: string | RegExp) {
  fireEvent.click(
    screen.getByRole('button', {
      name: typeof name === 'string' ? new RegExp(`^${name}`) : name,
    }),
  );
}

const githubConfig = {
  id: 'github',
  catalogKey: 'github',
  name: 'GitHub',
  url: '',
  authToken: 'github_pat_supersecret1234',
  enabled: true,
  createdAt: '2026-07-08T00:00:00.000Z',
};

describe('ConnectorsSection', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockFlags)) delete mockFlags[key];
    for (const key of Object.keys(mockOauthAvailability))
      delete mockOauthAvailability[key];
    mockAdminConnectors.length = 0;
    useSettingsStore.setState({
      mcpServers: [],
      allowArbitraryMcpServers: false,
      mcpArbitraryFlagEnabled: false,
    });
  });

  it('lists available connectors compactly instead of expanding all of them', () => {
    render(<ConnectorsSection />);

    expect(screen.getByText('Add a connector')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('Asana')).toBeInTheDocument();
    // The point of the redesign: no connector shouts its configuration UI
    // until it is asked for.
    expect(screen.queryByText('Connect with GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('Connect with Asana')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Use an access token instead'),
    ).not.toBeInTheDocument();
    // Nothing connected yet, so there is no "Your connectors" group.
    expect(screen.queryByText('Your connectors')).not.toBeInTheDocument();
  });

  it("reveals a connector's auth affordances only after it is added", () => {
    render(<ConnectorsSection />);

    addConnector('GitHub');

    // GitHub is dual-auth: OAuth primary + PAT fallback link.
    expect(screen.getByText('Connect with GitHub')).toBeInTheDocument();
    expect(screen.getByText('Use an access token instead')).toBeInTheDocument();
    // Its neighbours stay collapsed.
    expect(screen.queryByText('Connect with Asana')).not.toBeInTheDocument();
  });

  it('backs out of the add flow without connecting anything', () => {
    render(<ConnectorsSection />);
    addConnector('GitHub');

    fireEvent.click(screen.getByText('Cancel'));

    expect(screen.queryByText('Connect with GitHub')).not.toBeInTheDocument();
    expect(useSettingsStore.getState().mcpServers).toEqual([]);
    // And the entry is offerable again.
    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('moves a connected connector out of the browse list', () => {
    useSettingsStore.setState({ mcpServers: [githubConfig] });
    render(<ConnectorsSection />);

    expect(screen.getByText('Your connectors')).toBeInTheDocument();
    // Exactly one GitHub row — the connected one, not a second offer to add.
    expect(screen.getAllByText('GitHub')).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: /^GitHub/ }),
    ).not.toBeInTheDocument();
  });

  it('GitHub "Use an access token instead" reveals the PAT field', () => {
    render(<ConnectorsSection />);
    addConnector('GitHub');

    fireEvent.click(screen.getByText('Use an access token instead'));

    expect(screen.getByText('Personal access token')).toBeInTheDocument();
    // The submit button of the PAT form is the plain Connect.
    expect(screen.getByText('Connect')).toBeInTheDocument();
  });

  it('hides the arbitrary-servers area unless the LD flag is EXPLICITLY true (fail-closed)', () => {
    // Flag absent (undefined) — unlike other flags, this must stay hidden.
    const { rerender } = render(<ConnectorsSection />);
    expect(
      screen.queryByText('Allow arbitrary MCP servers'),
    ).not.toBeInTheDocument();

    mockFlags.mcpArbitraryServers = true;
    rerender(<ConnectorsSection />);
    expect(screen.getByText('Allow arbitrary MCP servers')).toBeInTheDocument();
  });

  it('reveals the add button only after the user toggle is on', () => {
    mockFlags.mcpArbitraryServers = true;
    render(<ConnectorsSection />);

    expect(screen.queryByText('Add MCP server')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Allow arbitrary MCP servers/));

    expect(useSettingsStore.getState().allowArbitraryMcpServers).toBe(true);
    expect(screen.getByText('Add MCP server')).toBeInTheDocument();
  });

  it('shows a connected curated row with token tail and NEVER the full token', () => {
    useSettingsStore.setState({ mcpServers: [githubConfig] });

    const { container } = render(<ConnectorsSection />);

    expect(screen.getAllByText(/Connected/).length).toBeGreaterThan(0);
    expect(screen.getByText(/1234/)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('github_pat_supersecret1234');
    expect(
      screen.queryByDisplayValue('github_pat_supersecret1234'),
    ).not.toBeInTheDocument();
    // Enabled checkbox + disconnect affordances present.
    expect(screen.getByLabelText(/Available in chat/)).toBeChecked();
    expect(screen.getByText('Disconnect')).toBeInTheDocument();
  });

  it('disabling a connected server keeps its config (and token) in the store', () => {
    useSettingsStore.setState({ mcpServers: [githubConfig] });
    render(<ConnectorsSection />);

    fireEvent.click(screen.getByLabelText(/Available in chat/));

    const stored = useSettingsStore.getState().mcpServers[0];
    expect(stored.enabled).toBe(false);
    expect(stored.authToken).toBe('github_pat_supersecret1234');
  });

  it('lists arbitrary servers with edit/delete when flag + toggle are on', () => {
    mockFlags.mcpArbitraryServers = true;
    useSettingsStore.setState({
      allowArbitraryMcpServers: true,
      mcpServers: [
        {
          id: 'c1',
          name: 'My Server',
          url: 'https://mcp.example.com',
          enabled: true,
          createdAt: '2026-07-08T00:00:00.000Z',
        },
      ],
    });

    render(<ConnectorsSection />);

    expect(screen.getByText('My Server')).toBeInTheDocument();
    expect(screen.getByText('https://mcp.example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit MCP server')).toBeInTheDocument();
  });
  it('"Use your own OAuth app" reveals client credential fields and the callback URL', () => {
    render(<ConnectorsSection />);
    addConnector('GitHub');

    fireEvent.click(screen.getAllByText('Use your own OAuth app')[0]);

    expect(screen.getByText('Client ID')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue(/\/mcp-oauth-callback$/),
    ).toBeInTheDocument();
  });

  it('hides "Connect with {name}" when the deployment has no OAuth app for it', () => {
    mockOauthAvailability.github = false;
    render(<ConnectorsSection />);
    addConnector('GitHub');

    // GitHub loses the OAuth button but keeps its PAT path.
    expect(screen.queryByText('Connect with GitHub')).not.toBeInTheDocument();
    expect(screen.getByText('Use an access token instead')).toBeInTheDocument();
  });

  it("leaves a still-configured connector untouched by another's missing app", () => {
    mockOauthAvailability.github = false;
    render(<ConnectorsSection />);
    addConnector('Asana');

    expect(screen.getByText('Connect with Asana')).toBeInTheDocument();
  });

  it('an OAuth-only connector with no deployment app falls back to bring-your-own-app', () => {
    mockOauthAvailability.asana = false;
    render(<ConnectorsSection />);
    addConnector('Asana');

    expect(screen.queryByText('Connect with Asana')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Signing in with Asana isn't set up/),
    ).toBeInTheDocument();
    // The only remaining path is revealed rather than hidden behind a toggle.
    expect(screen.getByText('Client ID')).toBeInTheDocument();
  });

  it('a typed own-app client id brings the connect button back', () => {
    mockOauthAvailability.asana = false;
    render(<ConnectorsSection />);
    addConnector('Asana');

    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: 'my-own-client-id' },
    });

    expect(screen.getByText('Connect with Asana')).toBeInTheDocument();
  });

  it('hides "Reconnect" on a needs-reauth connector with no app to reconnect through', () => {
    mockOauthAvailability.github = false;
    useSettingsStore.setState({
      mcpServers: [
        {
          ...githubConfig,
          authToken: undefined,
          authMode: 'oauth',
          oauth: { clientId: 'gone', needsReauth: true },
        },
      ],
    });
    render(<ConnectorsSection />);

    expect(screen.getByText('Needs reconnect')).toBeInTheDocument();
    expect(screen.queryByText('Reconnect')).not.toBeInTheDocument();
    // Disconnecting is still offered — the row never becomes a dead end.
    expect(screen.getByText('Disconnect')).toBeInTheDocument();
  });

  describe('admin-authored connectors', () => {
    const netsuite = {
      id: 'connector-abc123def456',
      name: 'Contoso NetSuite',
      description: 'Query NetSuite records',
      authStyle: 'bearer' as const,
      oauthAppConfigured: false,
    };

    it('renders nothing for the section when the user has no connectors', () => {
      render(<ConnectorsSection />);

      expect(
        screen.queryByText('Provided by your organization'),
      ).not.toBeInTheDocument();
    });

    it('offers an entitled connector in the browse list, grouped apart', () => {
      mockAdminConnectors.push(netsuite);
      render(<ConnectorsSection />);

      expect(screen.getByText('From your organization')).toBeInTheDocument();
      expect(screen.getByText('Contoso NetSuite')).toBeInTheDocument();
      expect(screen.getByText('Query NetSuite records')).toBeInTheDocument();
      // Collapsed like every other offer until it is added.
      expect(
        screen.queryByText('Personal access token'),
      ).not.toBeInTheDocument();
    });

    it('opens the token field immediately once a bearer connector is added', () => {
      // The user already expressed intent by adding it; making them click
      // Connect as well would be a second gesture for the same decision.
      mockAdminConnectors.push(netsuite);
      render(<ConnectorsSection />);

      addConnector('Contoso NetSuite');

      expect(screen.getByText('Personal access token')).toBeInTheDocument();
    });

    it('does NOT list a connected connector among arbitrary servers', () => {
      // Regression: the arbitrary-servers filter keyed only on !catalogKey,
      // so a connector rendered twice — the second time as a user-defined
      // server with an editable URL.
      mockFlags.mcpArbitraryServers = true;
      mockAdminConnectors.push(netsuite);
      useSettingsStore.setState({
        allowArbitraryMcpServers: true,
        mcpServers: [
          {
            id: netsuite.id,
            connectorId: netsuite.id,
            name: netsuite.name,
            url: '',
            authMode: 'bearer',
            authToken: 'tok_1234',
            enabled: true,
            createdAt: '2026-07-18T00:00:00.000Z',
          },
        ],
      });
      render(<ConnectorsSection />);

      // Exactly one row for it, and no Edit affordance (which only the
      // arbitrary-server rows render).
      expect(screen.getAllByText('Contoso NetSuite')).toHaveLength(1);
      expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    });

    it('explains instead of offering sign-in when a connector OAuth app is missing', () => {
      mockAdminConnectors.push({
        ...netsuite,
        authStyle: 'oauth',
        oauthAppConfigured: false,
      });
      render(<ConnectorsSection />);
      addConnector('Contoso NetSuite');

      expect(
        screen.getByText(/Sign-in isn't finished being set up/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Connect with Contoso NetSuite'),
      ).not.toBeInTheDocument();
    });

    it('offers sign-in when the connector OAuth app is configured', () => {
      mockAdminConnectors.push({
        ...netsuite,
        authStyle: 'oauth',
        oauthAppConfigured: true,
      });
      render(<ConnectorsSection />);
      addConnector('Contoso NetSuite');

      expect(
        screen.getByText('Connect with Contoso NetSuite'),
      ).toBeInTheDocument();
    });
  });
});
