import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ agentsEnabled: true }),
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
        const agents =
          scenario.listings[
            Math.min(listingCalls, scenario.listings.length - 1)
          ];
        listingCalls += 1;
        return jsonResponse(200, {
          success: true,
          data: {
            m365Agents: agents,
            m365AgentsUnavailable: false,
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

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <M365AgentsSection rules={[]} onDataChanged={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useSettingsStore.setState({ m365Connected: true, hiddenAdminAgentKeys: [] });
  useUIStore.setState({ isSettingsOpen: false });
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
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
