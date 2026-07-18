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

import { AgentAccessPanel } from '@/components/AgentAccess/AgentAccessPanel';
import type { AdminStoredRule } from '@/components/AgentAccess/types';

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

// Per-test fixtures the fetch mock serves; mutated in beforeEach/tests.
let meResponse: AgentAccessMe;
let meStatus: number;
let rulesResponse: AdminStoredRule[];
let rulesUnavailable: boolean;
let putStatus: number;
let putCalls: { headers: Record<string, string>; body: unknown }[];
let deleteStatus: number;
let deleteCalls: { url: string; headers: Record<string, string> }[];

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
  if (url.startsWith('/api/agents')) {
    // /api/agents responds without the {success, data} envelope.
    return jsonResponse(200, { agents: discoveredAgents });
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
    fetchMock.mockClear();
    vi.mocked(toast.success).mockClear();
    vi.stubGlobal('fetch', fetchMock);
    useSettingsStore.setState({ customAgentSources: [] });
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
});
