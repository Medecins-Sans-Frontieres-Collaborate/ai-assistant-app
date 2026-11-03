import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { OrgAgentsSection } from '@/components/AgentAccess/OrgAgentsSection';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <OrgAgentsSection rules={[]} onDataChanged={() => {}} />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('OrgAgentsSection listing recovery', () => {
  beforeEach(() => useSettingsStore.setState({ hiddenAdminAgentKeys: [] }));
  afterEach(() => vi.unstubAllGlobals());

  it.each([403, 500])(
    'does not treat a %i as empty or grant creation, and recovers on retry',
    async (initialStatus) => {
      let status = initialStatus;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                success: status === 200,
                data: { orgAgents: [], staticAgents: [], canCreate: true },
              }),
              { status },
            ),
        ),
      );
      const queryClient = renderSection();
      await waitFor(
        () =>
          expect(
            queryClient.getQueryState(['agent-access-org-agents'])?.status,
          ).toBe('error'),
        { timeout: 4000 },
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        "Couldn't load access data.",
      );
      expect(screen.queryByText('noOrgAgents')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'addOrgAgent' }),
      ).not.toBeInTheDocument();
      status = 200;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('noOrgAgents')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'addOrgAgent' })).toBeEnabled();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('reports storage unavailability with retry, not an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                orgAgents: [],
                staticAgents: [],
                canCreate: true,
                orgAgentsUnavailable: true,
              },
            }),
          ),
      ),
    );
    const queryClient = renderSection();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(['agent-access-org-agents'])?.status,
      ).toBe('success'),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'orgAgentsUnavailableWarning',
    );
    expect(screen.queryByText('noOrgAgents')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'addOrgAgent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
