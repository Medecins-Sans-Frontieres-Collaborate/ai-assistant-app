import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

import { AgentSourceForm } from '@/components/Chat/AgentSources/AgentSourceForm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable LaunchDarkly flags — empty by default (so `agentSourceBrowse` is
// undefined and treated as enabled, i.e. browse discovery available). Individual
// tests flip `agentSourceBrowse` to false to assert the prod manual-only path.
const mockFlags: Record<string, unknown> = {};
vi.mock('launchdarkly-react-client-sdk', () => ({
  useFlags: () => mockFlags,
}));

interface TreeFixture {
  subscriptions?: unknown[];
  failedSubscriptions?: unknown[];
  truncated?: boolean;
}

/**
 * Routes the tree-discovery /api/agents/browse?level=tree call (and the
 * connection-check /api/agents call) to canned responses by URL.
 *
 * Mirrors the real /api/agents route: agents discovered from the requested
 * `sources` path are tagged with that path via `source` (the form filters on
 * it). Fixtures may carry an explicit `source` to simulate entries from other
 * buckets (regional paths, prompt agents).
 */
function stubTreeFetch(routes: { tree?: TreeFixture; agents?: unknown[] }) {
  const fn = vi.fn((url: string) => {
    let body: Record<string, unknown> = {};
    if (url.includes('level=tree')) {
      body = {
        subscriptions: [],
        failedSubscriptions: [],
        truncated: false,
        ...routes.tree,
      };
    } else if (url.includes('/api/agents?')) {
      const requestedSource =
        new URL(url, 'http://localhost').searchParams.get('sources') ?? '';
      body = {
        agents: (routes.agents ?? []).map((a) =>
          a && typeof a === 'object' && !('source' in a)
            ? { ...a, source: requestedSource }
            : a,
        ),
      };
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    } as Response);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const project = (name: string) => ({ name });
const account = (
  name: string,
  resourceGroup: string,
  projects: { name: string }[],
  location?: string,
) => ({ name, resourceGroup, location, projects });
const subscription = (id: string, name: string, accounts: unknown[]) => ({
  id,
  name,
  accounts,
});

const TWO_PROJECT_TREE: TreeFixture = {
  subscriptions: [
    subscription('sub-1', 'Sub One', [
      account('acct-1', 'rg-1', [project('proj-1')], 'westeurope'),
      account('acct-2', 'rg-1', [project('proj-2')]),
    ]),
  ],
};

const AGENTS = [
  {
    id: 'agent-a',
    name: 'Agent A',
    description: 'first agent',
    agentName: 'agent-a',
    type: 'foundry',
  },
  {
    id: 'agent-b',
    name: 'Agent B',
    description: 'second agent',
    agentName: 'agent-b',
    type: 'foundry',
  },
];

/** Selects the proj-1 row and advances to the agent-selection step. */
async function advanceToStep2() {
  const row = await screen.findByRole('radio', { name: /acct-1 \/ proj-1/ });
  fireEvent.click(row);
  fireEvent.click(screen.getByRole('button', { name: 'next' }));
  // Step 2 renders the auto-add toggle once validation resolves.
  await screen.findByText('autoAddLabel');
}

describe('AgentSourceForm', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset flags between tests (default: browse enabled).
    for (const k of Object.keys(mockFlags)) delete mockFlags[k];
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches the pruned tree and renders projects grouped by subscription', async () => {
    const fetchFn = stubTreeFetch({ tree: TWO_PROJECT_TREE });

    render(<AgentSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('level=tree'),
      ),
    );
    expect(await screen.findByText('Sub One')).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /acct-1 \/ proj-1/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('radio', { name: /acct-2 \/ proj-2/ }),
    ).toBeInTheDocument();
  });

  it('shows inline name error and a selection banner when advancing an empty browse form', async () => {
    stubTreeFetch({ tree: TWO_PROJECT_TREE });
    const onSave = vi.fn();

    render(<AgentSourceForm onSave={onSave} onClose={vi.fn()} />);

    const next = await screen.findByRole('button', { name: 'next' });
    expect(next).not.toBeDisabled();

    fireEvent.click(next);

    expect(await screen.findByText('nameRequired')).toBeInTheDocument();
    // Name error is inline; the missing project selection surfaces once the
    // name is filled (browse mode has no per-field selects anymore).
    fireEvent.change(screen.getByPlaceholderText('namePlaceholder'), {
      target: { value: 'My Source' },
    });
    fireEvent.click(next);
    expect(
      await screen.findByText('projectSelectionRequired'),
    ).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('auto-selects a lone project and seeds the name from the account', async () => {
    stubTreeFetch({
      tree: {
        subscriptions: [
          subscription('sub-1', 'Only Subscription', [
            account('msf-foundry', 'rg-1', [project('default')]),
          ]),
        ],
      },
    });

    render(<AgentSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    // The lone project is picked automatically; a 'default' project seeds the
    // connection name from the account instead.
    const nameInput = (await screen.findByPlaceholderText(
      'namePlaceholder',
    )) as HTMLInputElement;
    await waitFor(() => expect(nameInput.value).toBe('msf-foundry'));
    expect(
      screen.getByRole('radio', { name: /msf-foundry \/ default/ }),
    ).toBeChecked();
  });

  it('warns when some subscriptions could not be scanned', async () => {
    stubTreeFetch({
      tree: {
        ...TWO_PROJECT_TREE,
        failedSubscriptions: [{ id: 'sub-x', name: 'Broken Sub' }],
      },
    });

    render(<AgentSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    expect(
      await screen.findByText('discoveryPartialWarning'),
    ).toBeInTheDocument();
  });

  it('advances to agent selection with all agents checked, and saves exclusions', async () => {
    stubTreeFetch({ tree: TWO_PROJECT_TREE, agents: AGENTS });
    const onSave = vi.fn();

    render(<AgentSourceForm onSave={onSave} onClose={vi.fn()} />);
    await advanceToStep2();

    const agentA = screen.getByRole('checkbox', { name: /Agent A/ });
    const agentB = screen.getByRole('checkbox', { name: /Agent B/ });
    expect(agentA).toBeChecked();
    expect(agentB).toBeChecked();

    fireEvent.click(agentA);
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        resourcePath:
          '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1/projects/proj-1',
        autoAddNewAgents: true,
        excludedAgentNames: ['agent-a'],
        selectedAgentNames: [],
      }),
    );
  });

  it('excludes prompt agents and foreign-source entries from validation and step 2', async () => {
    // /api/agents merges every bucket: the validated connection's agents,
    // regional-path discoveries, and admin prompt agents. Only entries tagged
    // with the validated path may appear in the BYO picker.
    stubTreeFetch({
      tree: TWO_PROJECT_TREE,
      agents: [
        ...AGENTS,
        {
          id: 'prompt-abc123',
          name: 'Legal Advisor',
          description: 'admin persona',
          agentName: 'prompt-abc123',
          type: 'prompt',
          source: 'prompt-agent',
        },
        {
          id: 'regional-1',
          name: 'Regional Agent',
          description: 'from the regional path',
          agentName: 'regional-1',
          type: 'foundry',
          source:
            '/subscriptions/other/resourceGroups/rg-x/providers/Microsoft.CognitiveServices/accounts/other-acct/projects/other-proj',
        },
      ],
    });
    const onSave = vi.fn();

    render(<AgentSourceForm onSave={onSave} onClose={vi.fn()} />);
    await advanceToStep2();

    // agentCount reflects only this connection's two agents.
    expect(
      screen.getByText('connectionSuccessAgents', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Agent A/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Agent B/ })).toBeChecked();
    expect(
      screen.queryByRole('checkbox', { name: /Legal Advisor/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('checkbox', { name: /Regional Agent/ }),
    ).not.toBeInTheDocument();

    // Unchecking nothing and saving must not persist foreign agentNames.
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedAgentNames: [],
        selectedAgentNames: [],
      }),
    );
  });

  it('saves an explicit allow-list when auto-add is turned off', async () => {
    stubTreeFetch({ tree: TWO_PROJECT_TREE, agents: AGENTS });
    const onSave = vi.fn();

    render(<AgentSourceForm onSave={onSave} onClose={vi.fn()} />);
    await advanceToStep2();

    fireEvent.click(screen.getByRole('checkbox', { name: /Agent B/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /autoAddLabel/ }));
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        autoAddNewAgents: false,
        excludedAgentNames: [],
        selectedAgentNames: ['agent-a'],
      }),
    );
  });

  it('pre-unchecks persisted exclusions when editing an existing source', async () => {
    stubTreeFetch({ tree: TWO_PROJECT_TREE, agents: AGENTS });

    render(
      <AgentSourceForm
        onSave={vi.fn()}
        onClose={vi.fn()}
        existingSource={{
          id: 'src-1',
          name: 'Existing',
          resourcePath:
            '/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.CognitiveServices/accounts/acct-1/projects/proj-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          autoAddNewAgents: true,
          excludedAgentNames: ['agent-b'],
          selectedAgentNames: [],
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'next' }));
    await screen.findByText('autoAddLabel');

    expect(screen.getByRole('checkbox', { name: /Agent A/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Agent B/ })).not.toBeChecked();
  });

  it('hides browse and never calls /api/agents/browse when agentSourceBrowse is false (prod)', async () => {
    mockFlags.agentSourceBrowse = false;
    const fetchFn = stubTreeFetch({});

    render(<AgentSourceForm onSave={vi.fn()} onClose={vi.fn()} />);

    // Manual entry is forced: the subscription-id input is rendered immediately.
    expect(
      await screen.findByPlaceholderText(
        'e49ac66c-c18d-4586-b132-8f201de8f2c2',
      ),
    ).toBeInTheDocument();
    // No browse toggle in either direction.
    expect(
      screen.queryByRole('button', { name: 'enterManually' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'browseResources' }),
    ).not.toBeInTheDocument();
    // Crucially, no Azure-resource discovery call is made.
    expect(fetchFn).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/agents/browse'),
    );
  });

  it('still reaches agent selection via manual entry when the flag is off', async () => {
    mockFlags.agentSourceBrowse = false;
    stubTreeFetch({ agents: AGENTS });
    const onSave = vi.fn();

    render(<AgentSourceForm onSave={onSave} onClose={vi.fn()} />);

    fireEvent.change(
      await screen.findByPlaceholderText(
        'e49ac66c-c18d-4586-b132-8f201de8f2c2',
      ),
      { target: { value: 'sub-9' } },
    );
    fireEvent.change(screen.getByPlaceholderText('rg-my-foundry'), {
      target: { value: 'rg-9' },
    });
    fireEvent.change(screen.getByPlaceholderText('my-foundry-account'), {
      target: { value: 'acct-9' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'next' }));

    // The step-2 agent picker is not flag-gated.
    await screen.findByText('autoAddLabel');
    expect(screen.getByRole('checkbox', { name: /Agent A/ })).toBeChecked();
  });
});
