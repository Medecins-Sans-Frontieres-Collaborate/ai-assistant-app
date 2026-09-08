import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import { SearchMode } from '@/types/searchMode';

import { AgentsTab } from '@/components/Chat/ModelSelect/AgentsTab';

import { getOrganizationAgents } from '@/lib/organizationAgents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Note: next-intl and next-auth are mocked globally in vitest.setup.dom.ts.
// The intl mock echoes the key when a message is missing from its fixture, so
// assertions anchor on the error containers' test ids and on behaviour rather
// than on English wording — except the empty-state card, whose copy the
// fixture does carry and which several cases must prove is absent.
const flags = vi.hoisted(() => ({ exploreBots: true as boolean | undefined }));
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => flags,
}));

// One bundled static agent — the row that keeps rendering while the fast half
// of discovery is down, and which the error row must not replace. Mutable per
// test: an admin rule can suppress the whole static list, which is what leaves
// the section with nothing but an error to show.
const staticAgents = vi.hoisted(() => [
  {
    id: 'msf_communications',
    name: 'MSF Communications',
    description: 'Static knowledge-base agent',
    icon: 'IconNews',
    color: '#e4032e',
    type: 'rag',
    enabled: true,
  },
]);
vi.mock('@/lib/organizationAgents', () => ({
  getOrganizationAgents: vi.fn(() => staticAgents),
  getIconComponent: () => (props: { size?: number }) => (
    <svg width={props.size} height={props.size} />
  ),
}));

type AgentsTabProps = React.ComponentProps<typeof AgentsTab>;

const renderTab = (overrides: Partial<AgentsTabProps> = {}) =>
  render(
    <AgentsTab
      handleModelSelect={vi.fn()}
      organizationAgentModels={[]}
      foundryAgents={[]}
      regionalPath={null}
      officePaths={[]}
      selectedModelId={null}
      onRefreshAgents={vi.fn()}
      agentSources={[]}
      onAddSource={vi.fn()}
      onDeleteSource={vi.fn()}
      hiddenIds={new Set<string>()}
      onHideAgent={vi.fn()}
      onUnhideAgent={vi.fn()}
      selectedModel={undefined}
      modelConfig={null}
      isCustomAgent={false}
      displaySearchMode={SearchMode.OFF}
      showModelAdvanced={false}
      selectedConversation={null}
      mobileView="list"
      setMobileView={vi.fn()}
      setShowModelAdvanced={vi.fn()}
      updateConversation={vi.fn()}
      {...overrides}
    />,
  );

describe('AgentsTab discovery failure surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.exploreBots = true;
    vi.mocked(getOrganizationAgents).mockReturnValue(staticAgents);
  });

  it('renders nothing about errors on a healthy load', () => {
    renderTab();

    expect(screen.queryByTestId('agents-load-error')).toBeNull();
    expect(screen.queryByTestId('agents-discovery-error')).toBeNull();
  });

  it('shows the fast-half error with a retry alongside the static agent', () => {
    const onRetryAgents = vi.fn();
    renderTab({ isFoundryAgentsError: true, onRetryAgents });

    const errorRow = screen.getByTestId('agents-load-error');
    expect(errorRow).toBeInTheDocument();

    // "Here is what we have, and something failed to load" — the bundled agent
    // that did load must survive the error state.
    expect(
      screen.getByRole('button', { name: /MSF Communications/ }),
    ).toBeInTheDocument();

    fireEvent.click(within(errorRow).getByRole('button'));
    expect(onRetryAgents).toHaveBeenCalledTimes(1);
  });

  it('does not claim "no agents available" when the fast half failed', () => {
    // Nothing loaded and no sources connected: the empty state would otherwise
    // assert an absence the failed fetch cannot support.
    renderTab({ isFoundryAgentsError: true, organizationAgentModels: [] });

    expect(screen.getByTestId('agents-load-error')).toBeInTheDocument();
    expect(screen.queryByText('emptyState.title')).toBeNull();
    expect(
      screen.queryByText('No regional / organization agents available'),
    ).toBeNull();
  });

  it('uses the retry callback, not the cache-busting refresh, for the error action', () => {
    const onRetryAgents = vi.fn();
    const onRefreshAgents = vi.fn();
    renderTab({ isFoundryAgentsError: true, onRetryAgents, onRefreshAgents });

    fireEvent.click(
      within(screen.getByTestId('agents-load-error')).getByRole('button'),
    );

    expect(onRetryAgents).toHaveBeenCalledTimes(1);
    expect(onRefreshAgents).not.toHaveBeenCalled();
  });

  it('shows the discovery (slow half) error on its own, with a retry', () => {
    const onRetryAgents = vi.fn();
    renderTab({ isDiscoveryError: true, onRetryAgents });

    const row = screen.getByTestId('agents-discovery-error');
    fireEvent.click(within(row).getByRole('button'));

    expect(onRetryAgents).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('agents-load-error')).toBeNull();
  });

  it('suppresses the discovery error while agents are still loading', () => {
    renderTab({ isDiscoveryError: true, isLoadingFoundryAgents: true });

    expect(screen.queryByTestId('agents-discovery-error')).toBeNull();
  });

  it('suppresses the discovery error when the fast half already failed', () => {
    // One amber row is enough; the fast-half message is the actionable one.
    renderTab({ isFoundryAgentsError: true, isDiscoveryError: true });

    expect(screen.getByTestId('agents-load-error')).toBeInTheDocument();
    expect(screen.queryByTestId('agents-discovery-error')).toBeNull();
  });

  it('still surfaces a slow-half failure when every section is empty', () => {
    // The section that hosts the footnote used to be gated on there being
    // something to list, so the one state where the footnote is the only thing
    // left to say — an admin rule suppressing the bundled static agent, no
    // sources, discovery down — hid it and asserted "none available" instead.
    vi.mocked(getOrganizationAgents).mockReturnValue([]);
    renderTab({ isDiscoveryError: true, organizationAgentModels: [] });

    expect(screen.getByTestId('agents-discovery-error')).toBeInTheDocument();
    expect(
      screen.queryByText('No regional / organization agents available'),
    ).toBeNull();
    // ...and the list's own "nothing configured" card must not argue with it.
    expect(screen.queryByText('noOrgAgentsConfigured')).toBeNull();
  });

  it('keeps the empty state when the flag hides the section that would explain it', () => {
    // With exploreBots off there is no region section, so no error row can
    // render — the org agents are absent by policy, not by the failure, and
    // the empty-state card is the only thing left that says anything at all.
    flags.exploreBots = false;
    renderTab({ isFoundryAgentsError: true, organizationAgentModels: [] });

    expect(screen.queryByTestId('agents-load-error')).toBeNull();
    expect(
      screen.getByText('No regional / organization agents available'),
    ).toBeInTheDocument();
  });
});
