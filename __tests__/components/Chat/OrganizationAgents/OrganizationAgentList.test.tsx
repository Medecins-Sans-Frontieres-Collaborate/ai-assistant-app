import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { OrganizationAgentList } from '@/components/Chat/OrganizationAgents/OrganizationAgentList';

import { describe, expect, it, vi } from 'vitest';

// Static registry fixture — mirrors config/organization-agents.json's shape
// with a single enabled RAG agent, the real-world collision target.
vi.mock('@/lib/organizationAgents', () => ({
  getOrganizationAgents: () => [
    {
      id: 'msf_communications',
      name: 'MSF Communications',
      description: 'Static knowledge-base agent',
      icon: 'IconNews',
      color: '#e4032e',
      type: 'rag',
      enabled: true,
    },
  ],
  getIconComponent: () => (props: { size?: number }) => (
    <svg data-testid="agent-icon" width={props.size} height={props.size} />
  ),
}));

describe('OrganizationAgentList', () => {
  it('dedupes a Foundry-discovered agent that duplicates a static agent by name', () => {
    render(
      <OrganizationAgentList
        onSelect={vi.fn()}
        discoveredAgents={[
          {
            id: 'asst_123',
            name: 'MSF Communications',
            matchId: 'foundry-ab12cd34-asst_123',
          },
          {
            id: 'asst_456',
            name: 'Other Foundry Agent',
            matchId: 'foundry-ab12cd34-asst_456',
          },
        ]}
      />,
    );

    // The same-named Foundry duplicate collapses into the static row; the
    // distinct discovered agent still renders.
    expect(
      screen.getAllByRole('button', { name: /MSF Communications/ }),
    ).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: /Other Foundry Agent/ }),
    ).toBeInTheDocument();
  });

  it('does not hide a prompt agent whose name collides with a static agent', () => {
    const onSelect = vi.fn();
    render(
      <OrganizationAgentList
        onSelect={onSelect}
        discoveredAgents={[
          {
            id: 'prompt-abc123def456',
            name: 'MSF Communications',
            description: 'Admin persona recreation',
            matchId: 'org-prompt-abc123def456',
          },
        ]}
      />,
    );

    // Both the static agent AND the same-named prompt agent render — the
    // persona is a different agent (different bot id), not a duplicate.
    const rows = screen.getAllByRole('button', { name: /MSF Communications/ });
    expect(rows).toHaveLength(2);

    // The second row is the prompt agent; selecting it yields the persona,
    // not the static agent.
    fireEvent.click(rows[1]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'prompt-abc123def456',
        matchId: 'org-prompt-abc123def456',
      }),
    );
  });

  it('renders prompt agents with unique names alongside static agents', () => {
    render(
      <OrganizationAgentList
        onSelect={vi.fn()}
        discoveredAgents={[
          {
            id: 'prompt-fedcba987654',
            name: 'Legal Advisor',
            matchId: 'org-prompt-fedcba987654',
          },
        ]}
      />,
    );

    expect(
      screen.getByRole('button', { name: /MSF Communications/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Legal Advisor/ }),
    ).toBeInTheDocument();
  });

  it('still filters hidden prompt agents via hiddenIds', () => {
    render(
      <OrganizationAgentList
        onSelect={vi.fn()}
        discoveredAgents={[
          {
            id: 'prompt-abc123def456',
            name: 'Legal Advisor',
            matchId: 'org-prompt-abc123def456',
          },
        ]}
        hiddenIds={new Set(['org-prompt-abc123def456'])}
      />,
    );

    expect(
      screen.queryByRole('button', { name: /Legal Advisor/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /MSF Communications/ }),
    ).toBeInTheDocument();
  });
});
