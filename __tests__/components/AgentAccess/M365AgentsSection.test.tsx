import {
  QueryClient,
  QueryClientProvider,
  focusManager,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import React from 'react';
import toast from 'react-hot-toast';

import { M365AgentsSection } from '@/components/AgentAccess/M365AgentsSection';
import type { AdminStoredM365Agent } from '@/components/AgentAccess/types';

import { useSettingsStore } from '@/client/stores/settingsStore';
import { useUIStore } from '@/client/stores/uiStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-hot-toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// The picker is a heavy Graph-backed modal; the section only mounts it.
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: () => null,
}));

const mockM365Flags = vi.hoisted(() => ({ agentsEnabled: true }));
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => mockM365Flags,
}));

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const baseAgent = (
  sources: AdminStoredM365Agent['agent']['sources'],
): AdminStoredM365Agent => ({
  canonicalKey: 'm365-agent::m365-0123456789ab',
  etag: '"etag-1"',
  agent: {
    version: 1,
    id: 'm365-0123456789ab',
    name: 'HR Handbook',
    description: 'Answers from the HR library',
    icon: undefined,
    systemPrompt: '',
    chatModelId: null,
    embeddingModelId: 'text-embedding',
    ragConfig: { topK: 10 },
    sources,
    createdBy: 'admin@example.org',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-09-01T00:00:00.000Z',
  } as AdminStoredM365Agent['agent'],
});

const indexedSource = {
  sourceId: 'src-1',
  driveId: 'b!drive',
  itemId: '01ITEM',
  kind: 'file' as const,
  title: 'Handbook.pdf',
  webUrl: 'https://contoso.sharepoint.com/Handbook.pdf',
  status: 'indexed' as const,
  indexedChunks: 12,
  recursive: false,
  excludedItemIds: [],
  counts: {
    indexable: 1,
    needsPreparation: 0,
    skipped: 0,
    bytes: 10,
    indexed: 1,
  },
};

/** Never indexed under the planner: no counts, so the row offers Index. */
const pendingSource = {
  ...indexedSource,
  status: 'pending' as const,
  indexedChunks: undefined,
  counts: undefined,
};

const runningJob = (done: number) => ({
  jobId: 'job-1',
  agentId: 'm365-0123456789ab',
  status: 'running' as const,
  mode: 'full' as const,
  stale: false,
  startedBy: 'admin@example.org',
  startedAt: '2026-09-14T10:00:00.000Z',
  updatedAt: `2026-09-14T10:00:0${done}.000Z`,
  total: 1,
  done,
  indexed: done,
  failed: 0,
  noText: 0,
  missing: 0,
});

interface Scenario {
  /** Listing responses in order (last one repeats). */
  listings: AdminStoredM365Agent[][];
  /** Step responses in order (last one repeats). */
  steps?: Response[];
  /** Rejected management listings are independent of discovery/rules. */
  listingStatus?: number;
  listingUnavailable?: boolean;
}

function installFetch(scenario: Scenario) {
  let listingCalls = 0;
  let stepCalls = 0;
  const calls: string[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/agent-access/m365-agents') {
        if (scenario.listingStatus && scenario.listingStatus !== 200) {
          return jsonResponse(scenario.listingStatus, {
            error: 'Listing failed',
          });
        }
        const agents =
          scenario.listings[
            Math.min(listingCalls, scenario.listings.length - 1)
          ];
        listingCalls += 1;
        return jsonResponse(200, {
          success: true,
          data: {
            m365Agents: agents,
            m365AgentsUnavailable: scenario.listingUnavailable ?? false,
            fetchedAt: 1,
            maxDocuments: 50,
            maxBytes: 512 * 1024 * 1024,
            jobs: {},
          },
        });
      }
      if (url === '/api/agent-access/m365-agents/index') {
        return jsonResponse(200, {
          success: true,
          data: { job: runningJob(0) },
        });
      }
      if (url === '/api/agent-access/m365-agents/index/step') {
        const steps = scenario.steps ?? [];
        const response = steps[Math.min(stepCalls, steps.length - 1)];
        stepCalls += 1;
        return response.clone();
      }
      return jsonResponse(404, { error: `unmocked ${url}` });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

function renderSection(searchQuery = '') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <M365AgentsSection
        rules={[]}
        searchQuery={searchQuery}
        onDataChanged={() => {}}
      />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

beforeEach(() => {
  mockM365Flags.agentsEnabled = true;
  useSettingsStore.setState({ m365Connected: true, hiddenAdminAgentKeys: [] });
  useUIStore.setState({ isSettingsOpen: false });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.unstubAllGlobals();
});

describe('M365AgentsSection — document cap save payload', () => {
  it.each([
    'stored override',
    'raise in editor',
    'raise then cancel',
    'failed raise',
    'stale raise',
  ])(
    'preserves the independently saved 80-file cap with a %s',
    async (scenario) => {
      const agent = baseAgent(
        Array.from({ length: 51 }, (_, index) => ({
          ...indexedSource,
          sourceId: `src-${index}`,
          itemId: `file-${index}`,
          title: `Document-${index}.pdf`,
        })),
      );
      if (scenario === 'stored override') {
        agent.agent.maxDocumentsOverride = 80;
      }
      const savePayloads: Record<string, unknown>[] = [];
      const capPayloads: Record<string, unknown>[] = [];
      const planCaps: number[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/agent-access/m365-agents') {
          if (init?.method === 'PATCH') {
            const payload = JSON.parse(String(init.body));
            capPayloads.push(payload);
            if (scenario === 'failed raise' || scenario === 'stale raise') {
              return jsonResponse(scenario === 'stale raise' ? 409 : 503, {
                error: 'Limit save failed',
              });
            }
            agent.agent = {
              ...agent.agent,
              maxDocumentsOverride: payload.maxDocumentsOverride,
            };
            agent.etag = '"etag-2"';
            return jsonResponse(200, {
              success: true,
              data: { agent: agent.agent, etag: agent.etag },
            });
          }
          if (init?.method === 'PUT') {
            const payload = JSON.parse(String(init.body));
            savePayloads.push(payload);
            return jsonResponse(
              agent.agent.maxDocumentsOverride === 80 ? 200 : 400,
              agent.agent.maxDocumentsOverride === 80
                ? { success: true, data: { agent: agent.agent } }
                : {
                    error:
                      'Sources expand to 51 documents; at most 50 are allowed',
                  },
            );
          }
          return jsonResponse(200, {
            success: true,
            data: {
              m365Agents: [agent],
              maxDocuments: 50,
              maxBytes: 512 * 1024 * 1024,
              maxDocumentsCeilings: { localAdmin: 100, globalAdmin: 200 },
              isGlobalAdmin: true,
              jobs: {},
            },
          });
        }
        if (url === '/api/agent-access/m365-agents/plan') {
          const payload = JSON.parse(String(init?.body));
          const cap = payload.maxDocuments ?? 50;
          planCaps.push(cap);
          return jsonResponse(200, {
            success: true,
            data: {
              plans: [],
              totalDocuments: 51,
              totalBytes: 51 * 1024,
              maxDocuments: cap,
              maxBytes: 512 * 1024 * 1024,
              overDocumentCap: 51 > cap,
              overByteCap: false,
            },
          });
        }
        return jsonResponse(404, { error: `unmocked ${url}` });
      });
      vi.stubGlobal('fetch', fetchMock);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      try {
        renderSection();
        fireEvent.click(
          await screen.findByRole(
            'button',
            { name: 'Edit agent' },
            { timeout: 5000 },
          ),
        );
        if (scenario !== 'stored override') {
          fireEvent.change(screen.getByLabelText('m365AgentNameLabel'), {
            target: { value: 'Unsaved title' },
          });
          fireEvent.change(screen.getByLabelText('m365CapRaiseInputLabel'), {
            target: { value: '80' },
          });
          fireEvent.click(
            screen.getByRole('button', { name: 'm365CapRaiseApply' }),
          );
          expect(confirm).toHaveBeenCalledOnce();
          if (scenario === 'failed raise' || scenario === 'stale raise') {
            await screen.findByText(
              scenario === 'stale raise'
                ? 'Someone else changed this while you were editing. Reload to load the latest version, then make your change again.'
                : 'Limit save failed',
            );
            expect(agent.agent.maxDocumentsOverride).toBeUndefined();
            expect(
              screen.queryByText('Document limit saved: 80.'),
            ).not.toBeInTheDocument();
            expect(savePayloads).toHaveLength(0);
            expect(
              screen.getByDisplayValue('Unsaved title'),
            ).toBeInTheDocument();
            return;
          }
          await screen.findByText('Document limit saved: 80.');
          expect(capPayloads).toEqual([
            { id: agent.agent.id, maxDocumentsOverride: 80 },
          ]);
          expect(savePayloads).toHaveLength(0);
          expect(agent.agent.name).toBe('HR Handbook');
          expect(screen.getByDisplayValue('Unsaved title')).toBeInTheDocument();
          if (scenario === 'raise then cancel') {
            fireEvent.click(
              screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!,
            );
            fireEvent.click(
              await screen.findByRole('button', { name: 'Edit agent' }),
            );
            expect(screen.getByLabelText('m365CapRaiseInputLabel')).toHaveValue(
              80,
            );
            expect(screen.getByDisplayValue('HR Handbook')).toBeInTheDocument();
            expect(savePayloads).toHaveLength(0);
            return;
          }
        }
        await waitFor(() => expect(planCaps).toContain(80));
        const save = screen.getByRole('button', { name: 'Save' });
        await waitFor(() => expect(save).toBeEnabled());
        fireEvent.click(save);
        await waitFor(() => expect(savePayloads).toHaveLength(1));
        expect(savePayloads[0]).toMatchObject({
          id: agent.agent.id,
        });
        expect(savePayloads[0]).not.toHaveProperty('maxDocumentsOverride');
        if (scenario === 'raise in editor') {
          expect(savePayloads[0].name).toBe('Unsaved title');
          const saveCall = fetchMock.mock.calls.find(
            ([, init]) => init?.method === 'PUT',
          );
          expect(saveCall?.[1]?.headers).toMatchObject({
            'If-Match': '"etag-2"',
          });
        }
        expect(savePayloads[0].sources).toHaveLength(51);
        await waitFor(() => expect(toast.success).toHaveBeenCalled());
        expect(toast.error).not.toHaveBeenCalled();
      } finally {
        confirm.mockRestore();
      }
    },
  );
});

describe('M365AgentsSection — management visibility diagnostics', () => {
  it('searches aggregated document counts without treating zero failures as failed status', async () => {
    const agent = baseAgent([
      {
        ...indexedSource,
        counts: { ...indexedSource.counts, indexed: 75, failed: 0 },
      },
    ]);
    installFetch({ listings: [[agent]] });
    const view = renderSection('75 documents');
    expect(await screen.findByText('HR Handbook')).toBeInTheDocument();
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <M365AgentsSection
          rules={[]}
          searchQuery="failed"
          onDataChanged={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('HR Handbook')).not.toBeInTheDocument();
    expect(screen.getByText('No matches for “failed”')).toBeInTheDocument();
  });
  it('does not mount the section or fetch its listing when the capability flag is false', () => {
    mockM365Flags.agentsEnabled = false;
    const { calls } = installFetch({
      listings: [[baseAgent([indexedSource])]],
    });
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
    expect(calls).toEqual([]);
  });

  it('keeps source editing available while disconnected and for an agent with no indexed content', async () => {
    useSettingsStore.setState({ m365Connected: false });
    installFetch({ listings: [[baseAgent([pendingSource])]] });
    renderSection();
    const edit = await screen.findByRole('button', { name: 'Edit agent' });
    expect(edit).toBeEnabled();
    expect(screen.getByText('m365AgentsHeading')).toBeInTheDocument();
    fireEvent.click(edit);
    expect(screen.getAllByText('Handbook.pdf')).toHaveLength(2);
  });

  it.each([401, 403, 500])(
    'keeps the section mounted after a %i listing failure, even though the agent controls disappear',
    async (listingStatus) => {
      const scenario = {
        listings: [[baseAgent([indexedSource])]],
        listingStatus,
      };
      installFetch(scenario);
      const { queryClient } = renderSection();
      await waitFor(
        () => {
          expect(
            queryClient.getQueryState(['agent-access-m365-agents'])?.status,
          ).toBe('error');
        },
        { timeout: 4000 },
      );
      expect(screen.getByText('m365AgentsHeading')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Edit agent' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('noM365Agents')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent(
        "Couldn't load access data.",
      );
      expect(
        screen.getByRole('button', { name: 'addM365Agent' }),
      ).toBeDisabled();
      scenario.listingStatus = 200;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('HR Handbook')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit agent' })).toBeEnabled();
    },
  );

  it('keeps the section mounted and reports a server-side store outage', async () => {
    installFetch({ listings: [[]], listingUnavailable: true });
    const { queryClient } = renderSection();
    await waitFor(() => {
      expect(
        queryClient.getQueryState(['agent-access-m365-agents'])?.status,
      ).toBe('success');
    });
    expect(screen.getByText('m365AgentsHeading')).toBeInTheDocument();
    expect(
      screen.getByText('m365AgentsUnavailableWarning'),
    ).toBeInTheDocument();
    expect(screen.queryByText('noM365Agents')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('recovers a failed listing when the admin returns to the window', async () => {
    const scenario = {
      listings: [[baseAgent([indexedSource])]],
      listingStatus: 500,
    };
    installFetch(scenario);
    const { queryClient } = renderSection();
    await waitFor(
      () =>
        expect(
          queryClient.getQueryState(['agent-access-m365-agents'])?.status,
        ).toBe('error'),
      { timeout: 4000 },
    );
    scenario.listingStatus = 200;
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(await screen.findByText('HR Handbook')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows loading instead of an empty list while the first request is pending', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );
    renderSection();
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByText('noM365Agents')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'addM365Agent' })).toBeDisabled();
    await act(async () => {
      resolve(jsonResponse(200, { success: true, data: { m365Agents: [] } }));
    });
    expect(await screen.findByText('noM365Agents')).toBeInTheDocument();
  });

  it('does not refetch on focus while a source editor has an unsaved draft', async () => {
    const original = baseAgent([indexedSource]);
    const { calls } = installFetch({
      listings: [[original], [{ ...original, etag: '"updated"' }]],
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit agent' }));
    const name = screen.getByDisplayValue('HR Handbook');
    fireEvent.change(name, { target: { value: 'Unsaved title' } });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(screen.getByDisplayValue('Unsaved title')).toBeInTheDocument();
    expect(
      calls.filter((call) => call === 'GET /api/agent-access/m365-agents'),
    ).toHaveLength(1);
  });
});

describe('M365AgentsSection — Microsoft 365 connection gating', () => {
  it('shows the disconnected notice, disables Index and opens Settings from it', async () => {
    useSettingsStore.setState({ m365Connected: false });
    installFetch({ listings: [[baseAgent([pendingSource])]] });
    renderSection();

    await screen.findByText('HR Handbook');
    expect(screen.getByText('m365SessionDisconnected')).toBeInTheDocument();
    const indexButton = screen.getByRole('button', { name: /m365AgentIndex$/ });
    expect(indexButton).toBeDisabled();
    expect(indexButton).toHaveAttribute('title', 'm365ActionNeedsConnection');

    fireEvent.click(
      screen.getByRole('button', { name: 'm365OpenConnections' }),
    );
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
  });

  it('turns an M365_NOT_CONNECTED step failure into the session notice without retrying', async () => {
    const { calls } = installFetch({
      listings: [[baseAgent([pendingSource])]],
      steps: [
        jsonResponse(401, {
          error: 'No Microsoft 365 session is available for this user',
          code: 'M365_NOT_CONNECTED',
        }),
      ],
    });
    renderSection();

    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentIndex$/ }),
    );
    await screen.findByText('m365SessionNotConnected');
    expect(
      screen.getByText('No Microsoft 365 session is available for this user'),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.endsWith('/index/step'))).toHaveLength(1);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('M365AgentsSection — step loop and post-run verdict', () => {
  it('retries a 503 step and then reports the agent as visible once indexed', async () => {
    const pending = baseAgent([pendingSource]);
    const indexed = baseAgent([indexedSource]);
    const { calls } = installFetch({
      listings: [[pending], [pending], [indexed]],
      steps: [
        jsonResponse(503, { error: 'upstream timeout' }),
        jsonResponse(200, {
          success: true,
          data: {
            job: {
              ...runningJob(1),
              status: 'succeeded',
              finishedAt: '2026-09-14T10:00:05.000Z',
            },
          },
        }),
      ],
    });
    renderSection();

    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentIndex$/ }),
    );
    await waitFor(
      () => {
        expect(screen.getByText('m365AgentRunVisible')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );
    expect(calls.filter((c) => c.endsWith('/index/step'))).toHaveLength(2);
    expect(toast.success).toHaveBeenCalled();
  }, 10000);

  it('reports "still hidden" with the per-source reasons when nothing was indexed', async () => {
    const pending = baseAgent([pendingSource]);
    const failed = baseAgent([
      {
        ...indexedSource,
        title: 'Budget.xls',
        status: 'error',
        indexedChunks: 0,
        error: 'Unsupported file type (.xls) — save it as .xlsx',
        counts: { indexable: 0, needsPreparation: 0, skipped: 1, bytes: 0 },
      },
    ]);
    installFetch({
      listings: [[pending], [pending], [failed]],
      steps: [
        jsonResponse(200, {
          success: true,
          data: {
            job: {
              ...runningJob(1),
              status: 'succeeded',
              indexed: 0,
              finishedAt: '2026-09-14T10:00:05.000Z',
            },
          },
        }),
      ],
    });
    renderSection();

    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentIndex$/ }),
    );
    await screen.findByText('m365AgentRunHidden');
    expect(screen.getByText('Budget.xls')).toBeInTheDocument();
    expect(
      screen.getByText(/Unsupported file type \(\.xls\)/),
    ).toBeInTheDocument();
    // Per-file reasons are one click away, not behind the editor.
    expect(
      screen.getByRole('button', { name: /m365AgentAttentionFiles/ }),
    ).toBeInTheDocument();
  });
});
