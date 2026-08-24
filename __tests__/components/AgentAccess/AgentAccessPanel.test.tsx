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
  AdminStoredConnector,
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

// Base chat model + two ids the model picker must filter out: an
// agent-backed id and a discovered deployment that is NOT in the static
// OpenAIModels registry (the server would 400 it).
const settingsModels = [
  { id: 'gpt-5.2', name: 'GPT-5.2', maxLength: 128000, tokenLimit: 16000 },
  { id: 'org-comms', name: 'Comms Bot', maxLength: 128000, tokenLimit: 16000 },
  {
    id: 'my-discovered-deployment',
    name: 'Mystery Deployment',
    maxLength: 128000,
    tokenLimit: 16000,
  },
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
/** Body served for failed (>=400) prompt-agent POST/PUT responses. */
let agentSaveErrorBody: unknown;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let groupSearchResponse: { id: string; name: string }[] = [];
let connectorsResponse: AdminStoredConnector[] = [];
let connectorsUnavailable = false;
/** Whether an admin record already overrides the built-in static agent. */
let staticOrgAgentOverridden = false;
let secretSealingAvailable = true;
const connectorWriteCalls: {
  method: string;
  headers: Record<string, string>;
  body: unknown;
  url: string;
}[] = [];

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
          ? agentSaveErrorBody
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
          ? agentSaveErrorBody
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
  if (url.startsWith('/api/agent-access/connectors')) {
    if (method !== 'GET') {
      connectorWriteCalls.push({
        method,
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse(200, { success: true, data: {} });
    }
    return jsonResponse(200, {
      success: true,
      data: {
        connectors: connectorsResponse,
        connectorsUnavailable,
        secretSealingAvailable,
        fetchedAt: 1752700000000,
      },
    });
  }
  if (url.startsWith('/api/agent-access/org-agents/indexes')) {
    return jsonResponse(200, {
      success: true,
      data: { indexes: ['live-aiassist-index'] },
    });
  }
  if (url.startsWith('/api/agent-access/org-agents')) {
    return jsonResponse(200, {
      success: true,
      data: {
        orgAgents: [],
        staticAgents: [
          {
            canonicalKey: 'org-agent::msf_communications',
            overridden: staticOrgAgentOverridden,
            agent: {
              id: 'msf_communications',
              name: 'MSF Communications',
              description: 'Public MSF content',
              icon: 'IconNews',
              color: '#4190f2',
              category: 'Knowledge Base',
              maintainedBy: 'MSF USA',
              systemPrompt: 'You are an information specialist.',
              sources: [{ name: 'msf.org', url: 'https://www.msf.org' }],
              searchIndex: 'live-aiassist-index',
              semanticConfig: '',
              topK: 10,
              baseModelId: null,
              allowWebSearch: true,
              allowCodeInterpreter: false,
              enabled: true,
            },
          },
        ],
        orgAgentsUnavailable: false,
        fetchedAt: 1752700000000,
        staticAgentIds: ['msf_communications'],
        canCreate: true,
      },
    });
  }
  if (url.startsWith('/api/agents')) {
    // /api/agents responds without the {success, data} envelope.
    return jsonResponse(200, { agents: agentsResponse });
  }
  if (url.startsWith('/api/m365/groups')) {
    return jsonResponse(200, {
      success: true,
      data: { groups: groupSearchResponse },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

/**
 * Sections are routes now rather than internal tab state, so a test opens one
 * by rendering it directly instead of clicking a tab strip that no longer
 * exists. Defaults to 'agents', which is what the old no-arg calls rendered.
 */
function renderPanel(
  section: React.ComponentProps<typeof AgentAccessPanel>['section'] = 'agents',
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentAccessEnabledContext.Provider value={true}>
        <AgentAccessPanel section={section} />
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
    agentSaveErrorBody = {};
    groupSearchResponse = [];
    connectorsResponse = [];
    connectorsUnavailable = false;
    staticOrgAgentOverridden = false;
    secretSealingAvailable = true;
    connectorWriteCalls.length = 0;
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

  it('restricted editor shows domain/user chip inputs and an editable Groups section', async () => {
    renderPanel();
    const row = await openEditorFor('Sales Agent');

    expect(within(row).getByText('Allowed domains')).toBeInTheDocument();
    expect(within(row).getByText('Allowed users')).toBeInTheDocument();
    // Stored domain chip; users list is empty so its placeholder shows.
    expect(within(row).getByText('msf.org')).toBeInTheDocument();
    expect(
      within(row).getByPlaceholderText('person@example.org'),
    ).toBeInTheDocument();

    // Groups: live since third pass §5 — search input + id chip input, no
    // disabled scaffold left.
    expect(within(row).getByText('Allowed groups')).toBeInTheDocument();
    expect(
      within(row).getByPlaceholderText('Search groups by name…'),
    ).toBeInTheDocument();
    expect(
      within(row).getByPlaceholderText('Entra group object ID'),
    ).toBeInTheDocument();
    const disabledInputs = within(row)
      .getAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).disabled);
    expect(disabledInputs).toHaveLength(0);
  });

  it('group typeahead adds an id chip with a name caption, and the id persists on save', async () => {
    groupSearchResponse = [
      { id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111', name: 'Field Comms' },
    ];
    renderPanel();
    const row = await openEditorFor('Sales Agent');

    fireEvent.change(
      within(row).getByPlaceholderText('Search groups by name…'),
      { target: { value: 'field' } },
    );
    // Past the 300ms debounce: the result row shows name + id.
    fireEvent.click(await within(row).findByText('Field Comms'));

    // The chip is the raw OBJECT ID (the persisted value); the caption maps
    // it to the display name for the admin.
    expect(
      within(row).getByText('aaaabbbb-cccc-dddd-eeee-ffff00001111'),
    ).toBeInTheDocument();
    expect(
      within(row).getByText(/Field Comms \(aaaabbbb…\)/),
    ).toBeInTheDocument();

    fireEvent.click(within(row).getByText('Save'));
    await waitFor(() => expect(putCalls).toHaveLength(1));
    expect(
      (putCalls[0].body as { access: { allowGroups: string[] } }).access
        .allowGroups,
    ).toEqual(['aaaabbbb-cccc-dddd-eeee-ffff00001111']);
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
      await screen.findByText("Couldn't load access data.", undefined, {
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

    const modelSelect = screen.getByRole('combobox', { name: 'Model' });
    // org-comms is agent-backed and must not be offered as an engine.
    expect(within(modelSelect).getByText('GPT-5.2')).toBeInTheDocument();
    expect(
      within(modelSelect).queryByText('Comms Bot'),
    ).not.toBeInTheDocument();
    // Discovered deployments outside the static OpenAIModels registry would
    // 400 server-side, so they must not be offered either.
    expect(
      within(modelSelect).queryByText('Mystery Deployment'),
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

  it('labels the stored model unavailable when gone from the registry and surfaces the 400 as a model-specific error', async () => {
    const retiredModelAgent: AdminStoredPromptAgent = {
      ...storedPromptAgent,
      agent: { ...storedPromptAgent.agent, modelId: 'retired-model' },
    };
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [retiredModelAgent];
    agentPutStatus = 400;
    agentSaveErrorBody = { error: 'modelId is not a known model' };
    renderPanel();

    const row = (await screen.findByText('Travel Advisor')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByText('Edit agent'));

    // The stored id stays selected (so other fields remain editable) but is
    // flagged: it is no longer in the OpenAIModels registry.
    const modelSelect = within(row as HTMLElement).getByRole('combobox', {
      name: 'Model',
    });
    expect((modelSelect as HTMLSelectElement).value).toBe('retired-model');
    expect(
      within(modelSelect).getByText('retired-model (unavailable)'),
    ).toBeInTheDocument();

    fireEvent.click(within(row as HTMLElement).getByText('Save'));

    // The 400 is surfaced as a model-specific, announced error — not the
    // generic "try again", which would suggest retrying could work.
    const alert = await within(row as HTMLElement).findByRole('alert');
    expect(alert).toHaveTextContent(
      'The selected model is no longer available. Choose another model and save again.',
    );
    expect(
      screen.queryByText("Couldn't save. Please try again."),
    ).not.toBeInTheDocument();
  });

  it('treats a PUT 404 (agent deleted elsewhere) as a conflict with Reload, not a retryable generic error', async () => {
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    agentPutStatus = 404;
    renderPanel();

    const row = (await screen.findByText('Travel Advisor')).closest('li');
    fireEvent.click(within(row as HTMLElement).getByText('Edit agent'));
    fireEvent.click(within(row as HTMLElement).getByText('Save'));

    // The conflict banner (announced to AT) with its Reload affordance —
    // retrying a PUT against a deleted agent can never succeed.
    const banner = await within(row as HTMLElement).findByRole('alert');
    expect(banner).toHaveTextContent(
      'Someone else changed this while you were editing. Reload to load the latest version, then make your change again.',
    );
    expect(within(row as HTMLElement).getByText('Reload')).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't save. Please try again."),
    ).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('Save')).toBeDisabled();
  });

  it('zero-key local admin still sees a prompt agent served by the server-filtered admin listing', async () => {
    // The admin listing is filtered per delegated key server-side with FRESH
    // config; /me may be a ≤60s-stale snapshot from another replica that
    // does not know about a fresh create's auto-delegation yet. The listing
    // wins: the row must not vanish behind stale editableAgentKeys.
    meResponse = {
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: [],
    };
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    renderPanel();

    const row = (await screen.findByText('Travel Advisor')).closest('li');
    expect(
      within(row as HTMLElement).getByText('Edit agent'),
    ).toBeInTheDocument();
    // Foundry rows still honor the delegated-key filter.
    expect(screen.queryByText('Helpdesk Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Sales Agent')).not.toBeInTheDocument();
  });

  it('associates a label with every editor control and exposes the Add agent expanded state', async () => {
    renderPanel();

    const addButton = await screen.findByRole('button', { name: 'Add agent' });
    expect(addButton).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(addButton);
    expect(addButton).toHaveAttribute('aria-expanded', 'true');

    // Each control is reachable by its accessible name (htmlFor/id pairs).
    expect(screen.getByLabelText('Name')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText('Description')).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(screen.getByLabelText('System prompt')).toBeInstanceOf(
      HTMLTextAreaElement,
    );
    expect(screen.getByLabelText('Model')).toBeInstanceOf(HTMLSelectElement);
  });

  it('lists the prompt agent in the local-admin delegation checkboxes', async () => {
    agentsResponse = [...discoveredAgents, promptAgentDiscoveryEntry];
    promptAgentsResponse = [storedPromptAgent];
    renderPanel('localAdmins');

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

  describe('connectors tab', () => {
    const netsuiteConnector: AdminStoredConnector = {
      canonicalKey: 'mcp-connector::connector-abc123def456',
      etag: '"etag-conn-1"',
      connector: {
        id: 'connector-abc123def456',
        name: 'Contoso NetSuite',
        description: 'Query NetSuite records',
        url: 'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all',
        transport: 'streamable-http',
        authStyle: 'oauth',
        oauthClientId: 'client-id',
        oauthScopes: [],
        hasClientSecret: true,
        createdBy: 'admin@example.org',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedBy: 'admin@example.org',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
    };

    const openConnectorsTab = async () => {
      renderPanel('connectors');
    };

    it('lists connectors with their URL and access state', async () => {
      connectorsResponse = [netsuiteConnector];
      await openConnectorsTab();

      expect(await screen.findByText('Contoso NetSuite')).toBeInTheDocument();
      expect(
        screen.getByText(
          'https://acct123.suitetalk.api.netsuite.com/services/mcp/v1/all',
        ),
      ).toBeInTheDocument();
      // No rule for this key → deny-list semantics means everyone.
      expect(screen.getByText('Everyone')).toBeInTheDocument();
    });

    it('shows the outage warning instead of an empty list', async () => {
      // An empty list during an outage would invite an admin to recreate a
      // connector that already exists.
      connectorsUnavailable = true;
      await openConnectorsTab();

      expect(
        await screen.findByText(/Couldn't reach the connector store/),
      ).toBeInTheDocument();
      expect(screen.queryByText('No connectors yet.')).not.toBeInTheDocument();
    });

    it('disables the OAuth style when the deployment cannot seal secrets', async () => {
      secretSealingAvailable = false;
      await openConnectorsTab();

      fireEvent.click(await screen.findByText('Add connector'));

      const oauthOption = (await screen.findByText(
        'OAuth sign-in',
      )) as HTMLOptionElement;
      expect(oauthOption.disabled).toBe(true);
      expect(
        screen.getByText(/this deployment has no AUTH_SECRET/),
      ).toBeInTheDocument();
    });

    it('omits the client secret from an edit that leaves the field blank', async () => {
      // The server reads "absent" as "keep the stored secret"; sending an
      // empty string would clear it.
      connectorsResponse = [netsuiteConnector];
      await openConnectorsTab();

      fireEvent.click(await screen.findByText('Edit'));
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => expect(connectorWriteCalls).toHaveLength(1));
      const call = connectorWriteCalls[0];
      expect(call.method).toBe('PUT');
      expect(call.headers['If-Match']).toBe('"etag-conn-1"');
      expect(call.body).not.toHaveProperty('oauthClientSecret');
      expect(call.body).toMatchObject({ id: 'connector-abc123def456' });
    });

    it('deletes with the CAS etag after confirmation', async () => {
      connectorsResponse = [netsuiteConnector];
      await openConnectorsTab();

      fireEvent.click(await screen.findByText('Delete'));
      fireEvent.click(screen.getByText('Delete connector'));

      await waitFor(() => expect(connectorWriteCalls).toHaveLength(1));
      const call = connectorWriteCalls[0];
      expect(call.method).toBe('DELETE');
      expect(call.url).toContain('id=connector-abc123def456');
      expect(call.headers['If-Match']).toBe('"etag-conn-1"');
    });

    it('prefills the OAuth endpoint URLs from the NetSuite template', async () => {
      await openConnectorsTab();
      fireEvent.click(await screen.findByText('Add connector'));

      fireEvent.change(screen.getByLabelText('Start from a template'), {
        target: { value: 'netsuite' },
      });

      expect(screen.getByLabelText('Authorization URL (optional)')).toHaveValue(
        'https://{accountid}.app.netsuite.com/app/login/oauth2/authorize.nl',
      );
      expect(screen.getByLabelText('Token URL (optional)')).toHaveValue(
        'https://{accountid}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
      );
      expect(screen.getByLabelText('Refresh URL (optional)')).toHaveValue(
        'https://{accountid}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
      );
      // The {accountid} placeholders block saving until replaced.
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('blocks saving when only one of the endpoint pair is set', async () => {
      connectorsResponse = [netsuiteConnector];
      await openConnectorsTab();
      fireEvent.click(await screen.findByText('Edit'));

      fireEvent.change(screen.getByLabelText('Authorization URL (optional)'), {
        target: { value: 'https://acct123.app.netsuite.com/authorize' },
      });

      expect(screen.getByText(/must be set together/)).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('sends the endpoint URLs on save and omits blank ones', async () => {
      connectorsResponse = [netsuiteConnector];
      await openConnectorsTab();
      fireEvent.click(await screen.findByText('Edit'));

      fireEvent.change(screen.getByLabelText('Authorization URL (optional)'), {
        target: { value: 'https://acct123.app.netsuite.com/authorize' },
      });
      fireEvent.change(screen.getByLabelText('Token URL (optional)'), {
        target: { value: 'https://acct123.suitetalk.api.netsuite.com/token' },
      });
      fireEvent.click(screen.getByText('Save'));

      await waitFor(() => expect(connectorWriteCalls).toHaveLength(1));
      expect(connectorWriteCalls[0].body).toMatchObject({
        oauthAuthorizationUrl: 'https://acct123.app.netsuite.com/authorize',
        oauthTokenUrl: 'https://acct123.suitetalk.api.netsuite.com/token',
      });
      // A blank refresh URL is omitted (server treats absence as "use the
      // token URL"), never sent as an empty string.
      expect(connectorWriteCalls[0].body).not.toHaveProperty('oauthRefreshUrl');
    });

    it('blocks saving while the URL still contains a template placeholder', async () => {
      await openConnectorsTab();
      fireEvent.click(await screen.findByText('Add connector'));

      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'My NetSuite' },
      });
      fireEvent.change(screen.getByLabelText('Server URL'), {
        target: { value: 'https://{accountid}.suitetalk.api.netsuite.com/x' },
      });

      expect(screen.getByText(/Replace the .* in the URL/)).toBeInTheDocument();
      expect(screen.getByText('Save')).toBeDisabled();
    });
  });
  describe('built-in org agents', () => {
    it('lists a static config agent with editable access and a prefilled override form', async () => {
      renderPanel();

      const row = await screen.findByTestId(
        'static-org-agent-msf_communications',
      );
      expect(within(row).getByText('MSF Communications')).toBeInTheDocument();
      // Missing mock keys fall back to the key name.
      expect(within(row).getByText('orgAgentBuiltinBadge')).toBeInTheDocument();
      // No rule stored under org-agent::msf_communications → implicit Everyone.
      expect(within(row).getByText('Everyone')).toBeInTheDocument();
      // Read-only settings: no edit/delete affordances on a built-in row.
      expect(
        within(row).queryByRole('button', { name: 'Delete agent' }),
      ).not.toBeInTheDocument();

      // Access is editable under the same canonical key the guard evaluates.
      fireEvent.click(within(row).getByRole('button', { name: 'Edit access' }));
      expect(
        within(row).getByText('Who can use this agent'),
      ).toBeInTheDocument();

      // Override opens the create form prefilled from the static entry with
      // the override target preselected — no re-keying the deployment config.
      fireEvent.click(
        within(row).getByRole('button', { name: 'orgAgentOverrideAction' }),
      );
      expect(screen.getByText('orgAgentOverrideTitle')).toBeInTheDocument();
      expect(
        (document.getElementById('org-agent-name') as HTMLInputElement).value,
      ).toBe('MSF Communications');
      expect(screen.getByDisplayValue('msf_communications')).toBeInstanceOf(
        HTMLSelectElement,
      );
      expect(screen.getByDisplayValue('live-aiassist-index')).toBeInstanceOf(
        HTMLSelectElement,
      );
    });

    it('hides a static agent that an admin record already overrides', async () => {
      staticOrgAgentOverridden = true;
      renderPanel();

      await screen.findByText('Helpdesk Agent');
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([input]) =>
            String(input).startsWith('/api/agent-access/org-agents'),
          ),
        ).toBe(true),
      );
      expect(
        screen.queryByTestId('static-org-agent-msf_communications'),
      ).not.toBeInTheDocument();
    });
  });
});
