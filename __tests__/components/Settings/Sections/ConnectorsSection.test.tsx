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
    useSettingsStore.setState({
      mcpServers: [],
      allowArbitraryMcpServers: false,
      mcpArbitraryFlagEnabled: false,
    });
  });

  it('renders both curated catalog rows with their auth affordances', () => {
    render(<ConnectorsSection />);

    expect(screen.getByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('Asana')).toBeInTheDocument();
    // GitHub is dual-auth: OAuth primary + PAT fallback link. Asana is
    // OAuth-only (no token fallback).
    expect(screen.getByText('Connect with GitHub')).toBeInTheDocument();
    expect(screen.getByText('Use an access token instead')).toBeInTheDocument();
    expect(screen.getByText('Connect with Asana')).toBeInTheDocument();
    expect(screen.queryByText('Connect')).not.toBeInTheDocument();
  });

  it('GitHub "Use an access token instead" reveals the PAT field', () => {
    render(<ConnectorsSection />);

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
});
