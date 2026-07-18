import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import React from 'react';
import toast from 'react-hot-toast';

import {
  AgentAccessEnabledContext,
  type AgentAccessMe,
} from '@/client/hooks/settings/useAgentAccessAdmin';

import type { OpenAIModel } from '@/types/openai';

import { AgentAccessPanel } from '@/components/AgentAccess/AgentAccessPanel';
import type {
  AdminConfigResponse,
  AdminStoredPromptAgent,
  AdminStoredRule,
  DiscoveredAgentSummary,
} from '@/components/AgentAccess/types';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// createNavigation pulls in the full i18n routing config; the panel only
// needs Link to render as an anchor.
vi.mock('@/lib/navigation', () => ({
  Link: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const globalAdminMe: AgentAccessMe = {
  isGlobalAdmin: true,
  isLocalAdmin: false,
  editableAgentKeys: '*',
};

const restrictedRule: AdminStoredRule = {
  canonicalKey: 'proj-a::sales',
  etag: '"etag-sales-1"',
  rule: {
    version: 1,
    source: 'proj-a',
    agentName: 'sales',
    access: {
      type: 'restricted',
      allowDomains: ['msf.org'],
      allowUsers: [],
      allowGroups: [],
    },
    updatedBy: 'admin@example.org',
    updatedAt: '2026-07-17T10:00:00.000Z',
  },
};

/** Rule whose agent is NOT in the admin's own /api/agents discovery. */
const undiscoveredRule: AdminStoredRule = {
  canonicalKey: 'proj-b::ghost',
  etag: '"etag-ghost-1"',
  rule: {
    version: 1,
    source: 'proj-b',
    agentName: 'ghost',
    access: {
      type: 'restricted',
      allowDomains: [],
      allowUsers: ['someone@example.org'],
      allowGroups: [],
    },
    updatedBy: 'admin@example.org',
    updatedAt: '2026-07-17T10:00:00.000Z',
  },
};

const discoveredAgents = [
  { id: 'a1', name: 'Helpdesk Agent', agentName: 'helpdesk', source: 'proj-a' },
  { id: 'a2', name: 'Sales Agent', agentName: 'sales', source: 'proj-a' },
];

const storedPromptAgent: AdminStoredPromptAgent = {
  canonicalKey: 'prompt-agent::prompt-abc123def456',
  etag: '"etag-pa-1"',
  agent: {
    version: 1,
    id: 'prompt-abc123def456',
    name: 'Travel Advisor',
    description: 'Helps plan travel',
    systemPrompt: 'You are a travel advisor.',
    modelId: 'gpt-5.2',
    createdBy: 'admin@example.org',
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-07-18T10:00:00.000Z',
  },
};

/** The same prompt agent as /api/agents emits it (no systemPrompt/modelId). */
const promptAgentDiscoveryEntry: DiscoveredAgentSummary = {
  id: 'prompt-abc123def456',
  name: 'Travel Advisor',
  description: 'Helps plan travel',
  agentName: 'prompt-abc123def456',
  source: 'prompt-agent',
  type: 'prompt',
};

// Base chat model + an agent-backed id the model picker must filter out.
const settingsModels = [
  { id: 'gpt-5.2', name: 'GPT-5.2', maxLength: 128000, tokenLimit: 16000 },
  { id: 'org-comms', name: 'Comms Bot', maxLength: 128000, tokenLimit: 16000 },
] as OpenAIModel[];

const configResponse: AdminConfigResponse = {
  config: {
    version: 1,
    localAdmins: [{ email: 'lead@example.org', agentKeys: [] }],
    updatedBy: 'admin@example.org',
    updatedAt: '2026-07-17T10:00:00.000Z',
  },
  etag: '"cfg-1"',
};

// Per-test fixtures the fetch mock serves; mutated in beforeEach/tests.
let meResponse: AgentAccessMe;
let meStatus: number;
let rulesResponse: AdminStoredRule[];
let rulesUnavailable: boolean;
let putStatus: number;
let putCalls: { headers: Record<string, string>; body: unknown }[];
let deleteStatus: number;
let deleteCalls: { url: string; headers: Record<string, string> }[];
let agentsResponse: DiscoveredAgentSummary[];
let promptAgentsResponse: AdminStoredPromptAgent[];
let agentPostStatus: number;
let agentPostCalls: { headers: Record<string, string>; body: unknown }[];
let agentPutStatus: number;
let agentPutCalls: { headers: Record<string, string>; body: unknown }[];
let agentDeleteStatus: number;
let agentDeleteCalls: { url: string; headers: Record<string, string> }[];

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (url.startsWith('/api/agent-access/me')) {
    if (meStatus !== 200) return jsonResponse(meStatus, {});
    return jsonResponse(200, { success: true, data: meResponse });
  }
  if (url.startsWith('/api/agent-access/rules')) {
    if (method === 'PUT') {
      putCalls.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse(
        putStatus,
        putStatus === 409 ? {} : { success: true, data: {} },
      );
    }
    if (method === 'DELETE') {
      deleteCalls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse(
        deleteStatus,
        deleteStatus >= 400 ? {} : { success: true, data: { deleted: true } },
      );
    }
    return jsonResponse(200, {
      success: true,
      data: {
        rules: rulesResponse,
        rulesUnavailable,
        fetchedAt: rulesUnavailable ? null : 1752700000000,
      },
    });
  }
  if (url.startsWith('/api/agent-access/prompt-agents')) {
    if (method === 'POST') {
      agentPostCalls.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse(
        agentPostStatus,
        agentPostStatus >= 400
          ? {}
          : {
              success: true,
              data: {
                promptAgent: storedPromptAgent.agent,
                etag: '"etag-pa-created"',
                canonicalKey: storedPromptAgent.canonicalKey,
              },
            },
      );
    }
    if (method === 'PUT') {
      agentPutCalls.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return jsonResponse(
        agentPutStatus,
        agentPutStatus >= 400
          ? {}
          : {
              success: true,
              data: {
                promptAgent: storedPromptAgent.agent,
                etag: '"etag-pa-2"',
                canonicalKey: storedPromptAgent.canonicalKey,
              },
            },
      );
    }
    if (method === 'DELETE') {
      agentDeleteCalls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return jsonResponse(
        agentDeleteStatus,
        agentDeleteStatus >= 400
          ? {}
          : {
              success: true,
              data: {
                canonicalKey: storedPromptAgent.canonicalKey,
                deleted: true,
              },
            },
      );
    }
    return jsonResponse(200, {
      success: true,
      data: {
        promptAgents: promptAgentsResponse,
        promptAgentsUnavailable: false,
        fetchedAt: 1752700000000,
      },
    });
  }
  if (url.startsWith('/api/agent-access/config')) {
    return jsonResponse(200, { success: true, data: configResponse });
  }
  if (url.startsWith('/api/agents')) {
    // /api/agents responds without the {success, data} envelope.
    return jsonResponse(200, { agents: agentsResponse });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentAccessEnabledContext.Provider value={true}>
        <AgentAccessPanel />
      </AgentAccessEnabledContext.Provider>
    </QueryClientProvider>,
  );
}

async function openEditorFor(displayName: string): Promise<HTMLElement> {
  const row = (await screen.findByText(displayName)).closest('li');
  expect(row).not.toBeNull();
  fireEvent.click(within(row as HTMLElement).getByText('Edit'));
  return row as HTMLElement;
}

describe('AgentAccessPanel', () => {
  beforeEach(() => {
    meResponse = globalAdminMe;
    meStatus = 200;
    rulesResponse = [restrictedRule, undiscoveredRule];
    rulesUnavailable = false;
    putStatus = 200;
    putCalls = [];
    deleteStatus = 200;
    deleteCalls = [];
    agentsResponse = discoveredAgents;
    promptAgentsResponse = [];
    agentPostStatus = 200;
    agentPostCalls = [];
    agentPutStatus = 200;
    agentPutCalls = [];
    agentDeleteStatus = 200;
    agentDeleteCalls = [];
    fetchMock.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.stubGlobal('fetch', fetchMock);
    useSettingsStore.setState({
      customAgentSources: [],
      models: settingsModels,
      userRegion: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders merged rows: discovered agents, access badges, and a "not discoverable" badge for rule-only rows', async () => {
    renderPanel();

    // Discovered agent without a rule → implicit Everyone.
    const helpdesk = (await screen.findByText('Helpdesk Agent')).closest('li');
    expect(
      within(helpdesk as HTMLElement).getByText('Everyone'),
    ).toBeInTheDocument();

    // Discovered agent with a restricted rule.
    const sales = screen.getByText('Sales Agent').closest('li');
    expect(
      within(sales as HTMLElement).getByText('Restricted'),
    ).toBeInTheDocument();
    expect(
      within(sales as HTMLElement).getByText(
        'Last updated by admin@example.org on 2026-07-17T10:00:00.000Z',
      ),
    ).toBeInTheDocument();

    // Rule whose agent is outside the admin's own discovery.
    const ghost = screen.getByText('ghost').closest('li');
    expect(
      within(ghost as HTMLElement).getByText('Not discoverable by you'),
    ).toBeInTheDocument();
    // Discovered rows carry no badge.
    expect(
      within(sales as HTMLElement).queryByText('Not discoverable by you'),
    ).not.toBeInTheDocument();
  });

  it('restricted editor shows domain/user chip inputs and a disabled Groups section', async () => {
    renderPanel();
    const row = await openEditorFor('Sales Agent');

    expect(within(row).getByText('Allowed domains')).toBeInTheDocument();
    expect(within(row).getByText('Allowed users')).toBeInTheDocument();
    // Stored domain chip; users list is empty so its placeholder shows.
    expect(within(row).getByText('msf.org')).toBeInTheDocument();
    expect(
      within(row).getByPlaceholderText('person@example.org'),
    ).toBeInTheDocument();

    // Groups: rendered but disabled, with the pending-consent note. The
    // groups chip input is the only disabled textbox in the editor.
    expect(within(row).getByText('Allowed groups')).toBeInTheDocument();
    expect(
      within(row).getByText(
        "Group-based access is pending tenant admin consent and can't be edited yet.",
      ),
    ).toBeInTheDocument();
    const disabledInputs = within(row)
      .getAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).disabled);
    expect(disabledInputs).toHaveLength(1);
  });

  it('local admins only see their delegated canonical keys', async () => {
    meResponse = {
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: ['proj-a::sales'],
    };
    renderPanel();

    expect(await screen.findByText('Sales Agent')).toBeInTheDocument();
    expect(screen.queryByText('Helpdesk Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('ghost')).not.toBeInTheDocument();
    // The delegation-map tab is global-admin only.
    expect(screen.queryByText('Local admins')).not.toBeInTheDocument();
  });

  it('shows the conflict message with a Reload action when saving hits a 409', async () => {
    putStatus = 409;
    renderPanel();
    const row = await openEditorFor('Sales Agent');

    fireEvent.click(within(row).getByText('Save'));

    expect(
      await within(row).findByText(
        'Someone else changed this while you were editing. Reload to load the latest version, then make your change again.',
      ),
    ).toBeInTheDocument();
    expect(within(row).getByText('Reload')).toBeInTheDocument();

    // The concurrent-edit guard rode along: the PUT carried the stored ETag.
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].headers['If-Match']).toBe('"etag-sales-1"');
    // Save stays disabled while the conflict is unresolved.
    expect(within(row).getByText('Save')).toBeDisabled();
  });

  it('shows the storage-outage warning instead of the merged list when rulesUnavailable is set', async () => {
    rulesUnavailable = true;
    rulesResponse = [];
    renderPanel();

    expect(
      await screen.findByText(
        'Access rules could not be loaded from storage. Agent invocation is currently blocked and rules cannot be edited.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();

    // The merged list must NOT render — it would show every agent as
    // "Everyone" while invocation is failing closed.
    expect(screen.queryByText('Helpdesk Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Everyone')).not.toBeInTheDocument();
  });

  it('shows the error branch when /me fails, and Retry refetches both /me and rules', async () => {
    meStatus = 500;
    renderPanel();

    // The /me query retries once with ~1s backoff before settling into its
    // error state, so allow more than the default findBy timeout.
    expect(
      await screen.findByText("Couldn't load agent access data.", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Helpdesk Agent')).not.toBeInTheDocument();

    const meCallsBefore = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/agent-access/me'),
    ).length;
    const rulesCallsBefore = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).startsWith('/api/agent-access/rules') &&
        (init?.method ?? 'GET') === 'GET',
    ).length;

    // Outage over: retry recovers to the merged list.
    meStatus = 200;
    fireEvent.click(screen.getByText('Retry'));

    expect(await screen.findByText('Helpdesk Agent')).toBeInTheDocument();
    const meCallsAfter = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('/api/agent-access/me'),
    ).length;
    const rulesCallsAfter = fetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input).startsWith('/api/agent-access/rules') &&
        (init?.method ?? 'GET') === 'GET',
    ).length;
    expect(meCallsAfter).toBeGreaterThan(meCallsBefore);
    expect(rulesCallsAfter).toBeGreaterThan(rulesCallsBefore);
  });

  it('treats a DELETE 404 as success: the rule is already gone, so toast + refetch instead of a dead-end error', async () => {
    deleteStatus = 404;
    renderPanel();
    const row = await openEditorFor('Sales Agent');

    // Switch the restricted rule back to Everyone → DELETE with If-Match.
    fireEvent.click(within(row).getByRole('radio', { name: /Everyone/ }));
    fireEvent.click(within(row).getByText('Save'));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'Access rule removed — everyone can use this agent again.',
      );
    });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].headers['If-Match']).toBe('"etag-sales-1"');
    // No dead-end save error; the editor closed via onSaved().
    expect(
      screen.queryByText("Couldn't save. Please try again."),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText('Who can use this agent'),
      ).not.toBeInTheDocument();
    });
  });

  it('normalizes pasted emails in the domains input and splits comma-separated entries before saving', async () => {
    renderPanel();
    const row = await openEditorFor('Sales Agent');

    // Domains input is the first textbox (users second, disabled groups third).
    const domainsInput = within(row).getAllByRole('textbox')[0];
    fireEvent.change(domainsInput, {
      // Email → domain; duplicate of the stored msf.org chip is dropped.
      target: { value: 'user@new-domain.org, MSF.org, second.org' },
    });
    fireEvent.keyDown(domainsInput, { key: 'Enter' });

    expect(within(row).getByText('new-domain.org')).toBeInTheDocument();
    expect(within(row).getByText('second.org')).toBeInTheDocument();
    // Only the original stored chip — the re-pasted duplicate was dropped.
    expect(within(row).getAllByText(/msf\.org/i)).toHaveLength(1);

    fireEvent.click(within(row).getByText('Save'));
    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(
      (putCalls[0].body as { access: { allowDomains: string[] } }).access
        .allowDomains,
    ).toEqual(['msf.org', 'new-domain.org', 'second.org']);
  });

  it('renders a prompt-agent row with badge and Edit agent / Delete actions', async () => {
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    renderPanel();

    const row = (await screen.findByText('Travel Advisor')).closest('li');
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).getByText('Prompt agent'),
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText('Edit agent'),
    ).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Delete')).toBeInTheDocument();
    // Discovered through /api/agents too, so no amber badge.
    expect(
      within(row as HTMLElement).queryByText('Not discoverable by you'),
    ).not.toBeInTheDocument();
    // Foundry rows carry neither the badge nor the prompt-agent actions.
    const foundryRow = screen.getByText('Helpdesk Agent').closest('li');
    expect(
      within(foundryRow as HTMLElement).queryByText('Prompt agent'),
    ).not.toBeInTheDocument();
    expect(
      within(foundryRow as HTMLElement).queryByText('Edit agent'),
    ).not.toBeInTheDocument();
  });

  it('creates a prompt agent: POST body from the form, agent-backed models filtered out of the picker', async () => {
    renderPanel();

    fireEvent.click(await screen.findByText('Add agent'));
    expect(screen.getByText('New prompt agent')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('e.g. Travel Advisor'), {
      target: { value: '  Concierge  ' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(
        'Instructions that define how this agent behaves',
      ),
      { target: { value: 'You are a concierge.' } },
    );

    const modelSelect = screen.getByRole('combobox');
    // org-comms is agent-backed and must not be offered as an engine.
    expect(within(modelSelect).getByText('GPT-5.2')).toBeInTheDocument();
    expect(
      within(modelSelect).queryByText('Comms Bot'),
    ).not.toBeInTheDocument();
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.2' } });

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(agentPostCalls).toHaveLength(1));
    expect(agentPostCalls[0].body).toEqual({
      name: 'Concierge',
      description: '',
      systemPrompt: 'You are a concierge.',
      modelId: 'gpt-5.2',
    });
    // Create-only: no If-Match rides along.
    expect(agentPostCalls[0].headers['If-Match']).toBeUndefined();
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Prompt agent created.');
    });
  });

  it('local admin with zero delegated keys still sees the Add agent button', async () => {
    meResponse = {
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: [],
    };
    rulesResponse = [];
    renderPanel();

    expect(await screen.findByText('Add agent')).toBeInTheDocument();
    // Nothing is delegated to them yet, so the list itself is empty.
    expect(screen.getByText('No agents to manage.')).toBeInTheDocument();
  });

  it('Edit agent PUT carries If-Match and body id; a 409 shows the conflict banner', async () => {
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    agentPutStatus = 409;
    renderPanel();

    const row = (await screen.findByText('Travel Advisor')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByText('Edit agent'));

    // Seeded from the stored record.
    expect(
      within(row as HTMLElement).getByDisplayValue('You are a travel advisor.'),
    ).toBeInTheDocument();
    fireEvent.change(
      within(row as HTMLElement).getByDisplayValue('Travel Advisor'),
      { target: { value: 'Travel Advisor v2' } },
    );
    fireEvent.click(within(row as HTMLElement).getByText('Save'));

    expect(
      await within(row as HTMLElement).findByText(
        'Someone else changed this while you were editing. Reload to load the latest version, then make your change again.',
      ),
    ).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Reload')).toBeInTheDocument();

    expect(agentPutCalls).toHaveLength(1);
    expect(agentPutCalls[0].headers['If-Match']).toBe('"etag-pa-1"');
    expect(agentPutCalls[0].body).toEqual({
      id: 'prompt-abc123def456',
      name: 'Travel Advisor v2',
      description: 'Helps plan travel',
      systemPrompt: 'You are a travel advisor.',
      modelId: 'gpt-5.2',
    });
  });

  it('deletes a prompt agent after inline confirm, sending DELETE with If-Match', async () => {
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    renderPanel();

    const row = (await screen.findByText('Travel Advisor')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByText('Delete'));
    // Nothing sent until the inline confirm.
    expect(agentDeleteCalls).toHaveLength(0);
    fireEvent.click(within(row as HTMLElement).getByText('Yes, delete'));

    await waitFor(() => expect(agentDeleteCalls).toHaveLength(1));
    expect(agentDeleteCalls[0].url).toBe(
      '/api/agent-access/prompt-agents?id=prompt-abc123def456',
    );
    expect(agentDeleteCalls[0].headers['If-Match']).toBe('"etag-pa-1"');
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Prompt agent deleted.');
    });
  });

  it('shows the conflict banner when the delete hits a 409', async () => {
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    agentDeleteStatus = 409;
    renderPanel();

    const row = (await screen.findByText('Travel Advisor')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByText('Delete'));
    fireEvent.click(within(row as HTMLElement).getByText('Yes, delete'));

    expect(
      await within(row as HTMLElement).findByText(
        'Someone else changed this while you were editing. Reload to load the latest version, then make your change again.',
      ),
    ).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Reload')).toBeInTheDocument();
    expect(agentDeleteCalls).toHaveLength(1);
  });

  it('lists the prompt agent in the local-admin delegation checkboxes', async () => {
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    renderPanel();

    fireEvent.click(await screen.findByText('Local admins'));

    // The section renders one card per configured local admin; the merged
    // rows — including the prompt agent — feed its delegation checkboxes.
    const promptLabel = (await screen.findByText('Travel Advisor')).closest(
      'label',
    );
    expect(promptLabel).not.toBeNull();
    expect(
      within(promptLabel as HTMLElement).getByRole('checkbox'),
    ).toBeInTheDocument();
    expect(
      within(promptLabel as HTMLElement).getByRole('checkbox'),
    ).not.toBeChecked();
  });
});
