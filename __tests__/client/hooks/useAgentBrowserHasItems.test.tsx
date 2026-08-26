import { renderHook } from '@testing-library/react';

import {
  useAgentBrowserAvailability,
  useAgentBrowserHasItems,
} from '@/client/hooks/settings/useAvailableAgents';

import type { DiscoveredAgent } from '@/lib/services/agents/AgentDiscoveryService';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let foundryAgents: Partial<DiscoveredAgent>[] = [];
let toolsEnabled = false;
let isLoadingFoundryAgents = false;
let isFoundryAgentsError = false;

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
    isLoadingFoundryAgents,
    isFoundryAgentsError,
    retryFoundryAgents: () => Promise.resolve(),
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
    isLoadingFoundryAgents = false;
    isFoundryAgentsError = false;
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

describe('useAgentBrowserAvailability', () => {
  beforeEach(() => {
    foundryAgents = [];
    toolsEnabled = false;
    isLoadingFoundryAgents = false;
    isFoundryAgentsError = false;
    useSettingsStore.setState({
      mcpServers: [],
      m365Connected: false,
      customAgentSources: [],
    } as Partial<SettingsState>);
  });

  it('is "loading" (never "empty") while discovery runs with nothing known', () => {
    isLoadingFoundryAgents = true;
    const { result } = renderHook(() => useAgentBrowserAvailability());
    expect(result.current).toEqual({ status: 'loading', hasItems: false });
  });

  it('is "ready" as soon as anything is known, even mid-load', () => {
    isLoadingFoundryAgents = true;
    useSettingsStore.setState({
      mcpServers: [{ id: 'srv-1', name: 'Asana', enabled: true }],
    } as Partial<SettingsState>);
    const { result } = renderHook(() => useAgentBrowserAvailability());
    expect(result.current.status).toBe('ready');
  });

  it('is "error" when discovery failed with nothing cached', () => {
    isFoundryAgentsError = true;
    const { result } = renderHook(() => useAgentBrowserAvailability());
    expect(result.current).toEqual({ status: 'error', hasItems: false });
  });

  it('is "empty" only after discovery finished with nothing', () => {
    const { result } = renderHook(() => useAgentBrowserAvailability());
    expect(result.current).toEqual({ status: 'empty', hasItems: false });
  });
});
