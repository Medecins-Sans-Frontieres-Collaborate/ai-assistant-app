import { renderHook } from '@testing-library/react';

import { useAgentBrowserHasItems } from '@/client/hooks/settings/useAvailableAgents';

import type { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let foundryAgents: Partial<DiscoveredAgent>[] = [];
let toolsEnabled = false;

vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => ({ exploreBots: true }),
}));

vi.mock('@/lib/organizationAgents', () => ({
  getOrganizationAgents: () => [],
}));

vi.mock('@/client/hooks/settings/useFoundryAgents', () => ({
  useFoundryAgents: () => ({
    foundryAgents,
    suppressedOrgAgentIds: [],
    isLoadingFoundryAgents: false,
  }),
}));

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ toolsEnabled }),
}));

type SettingsState = ReturnType<typeof useSettingsStore.getState>;

describe('useAgentBrowserHasItems', () => {
  beforeEach(() => {
    foundryAgents = [];
    toolsEnabled = false;
    useSettingsStore.setState({
      mcpServers: [],
      m365Connected: false,
      customAgentSources: [],
    } as Partial<SettingsState>);
  });

  it('is false with no agents, no connectors, and no M365 toolset', () => {
    const { result } = renderHook(() => useAgentBrowserHasItems());
    expect(result.current).toBe(false);
  });

  it('is true when at least one agent is available', () => {
    foundryAgents = [{ id: 'prompt-1', type: 'prompt', name: 'Beta Persona' }];
    const { result } = renderHook(() => useAgentBrowserHasItems());
    expect(result.current).toBe(true);
  });

  it('is true when an MCP connector is configured', () => {
    useSettingsStore.setState({
      mcpServers: [
        { id: 'srv-1', name: 'Asana', enabled: false },
      ] as SettingsState['mcpServers'],
    });
    const { result } = renderHook(() => useAgentBrowserHasItems());
    expect(result.current).toBe(true);
  });

  it('is true when the M365 toolset flag is on and the account is connected', () => {
    toolsEnabled = true;
    useSettingsStore.setState({ m365Connected: true });
    const { result } = renderHook(() => useAgentBrowserHasItems());
    expect(result.current).toBe(true);
  });

  it('is false when M365 is connected but the tools flag is off', () => {
    toolsEnabled = false;
    useSettingsStore.setState({ m365Connected: true });
    const { result } = renderHook(() => useAgentBrowserHasItems());
    expect(result.current).toBe(false);
  });
});
