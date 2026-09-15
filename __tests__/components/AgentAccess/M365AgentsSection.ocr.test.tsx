/**
 * Admin-row OCR controls and the screenshot fixes (2026-09-14): auto-OCR
 * opt-in, batch "Prepare all scanned PDFs", stacked attention rows with
 * OCR reasons, inline Retry after a failed job, bordered Re-index all.
 */
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
vi.mock('@/components/Chat/ChatInput/M365FilePickerModal', () => ({
  default: () => null,
}));
vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ agentsEnabled: true }),
}));

const AGENT_ID = 'm365-0123456789ab';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const agentWith = (
  sources: AdminStoredM365Agent['agent']['sources'],
  extra: Partial<AdminStoredM365Agent['agent']> = {},
): AdminStoredM365Agent => ({
  canonicalKey: `m365-agent::${AGENT_ID}`,
  etag: '"etag-1"',
  agent: {
    version: 1,
    id: AGENT_ID,
    name: 'HR Handbook',
    description: 'Answers from the HR library',
    systemPrompt: '',
    chatModelId: null,
    embeddingModelId: 'text-embedding',
    ragConfig: { topK: 10 },
    autoOcr: false,
    sources,
    createdBy: 'admin@example.org',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  } as AdminStoredM365Agent['agent'],
});

const folderSource = {
  sourceId: 'src-1',
  driveId: 'b!drive',
  itemId: '01FOLDER',
  kind: 'folder' as const,
  title: 'Policies',
  webUrl: 'https://contoso.sharepoint.com/Policies',
  status: 'indexed' as const,
  indexedChunks: 40,
  recursive: true,
  excludedItemIds: [],
  lastIndexedAt: '2026-09-14T04:02:46.000Z',
  counts: {
    indexable: 8,
    needsPreparation: 0,
    skipped: 0,
    bytes: 100,
    indexed: 6,
    noText: 2,
  },
};

const manifestItem = (
  itemId: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  itemId,
  driveId: 'b!drive',
  name,
  path: '',
  parentItemId: '01FOLDER',
  size: 1000,
  webUrl: `https://contoso.sharepoint.com/Policies/${name}`,
  tier: 'indexable',
  status: 'noText',
  indexedChunks: 0,
  ...extra,
});

const manifestWith = (items: unknown[]) => ({
  version: 1,
  agentId: AGENT_ID,
  updatedAt: '2026-09-14T04:02:46.000Z',
  sources: [
    {
      sourceId: 'src-1',
      status: 'indexed',
      truncated: false,
      folders: [],
      items,
    },
  ],
});

interface Scenario {
  agents: AdminStoredM365Agent[];
  jobs?: Record<string, unknown>;
  manifest?: unknown;
  /** Per-call prepare handler (sequential order preserved). */
  prepare?: (body: { itemId: string }) => Promise<Response>;
}

function installFetch(scenario: Scenario) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/agent-access/m365-agents' && method === 'GET') {
        return jsonResponse(200, {
          success: true,
          data: {
            m365Agents: scenario.agents,
            m365AgentsUnavailable: false,
            fetchedAt: 1,
            maxDocuments: 50,
            maxBytes: 512 * 1024 * 1024,
            ocrMaxPages: 120,
            autoOcrMaxPagesPerRun: 150,
            autoOcrMaxPagesPerFile: 40,
            jobs: scenario.jobs ?? {},
          },
        });
      }
      if (url === '/api/agent-access/m365-agents' && method === 'PUT') {
        return jsonResponse(200, {
          success: true,
          data: { m365Agent: scenario.agents[0].agent, etag: '"etag-2"' },
        });
      }
      if (url.startsWith('/api/agent-access/m365-agents/manifest')) {
        return jsonResponse(200, {
          success: true,
          data: { manifest: scenario.manifest ?? null },
        });
      }
      if (url === '/api/agent-access/m365-agents/prepare') {
        if (!scenario.prepare)
          return jsonResponse(404, { error: 'no prepare' });
        return scenario.prepare(body);
      }
      if (url === '/api/agent-access/m365-agents/index') {
        return jsonResponse(200, {
          success: true,
          data: {
            job: {
              jobId: 'job-2',
              agentId: AGENT_ID,
              status: 'succeeded',
              mode: 'full',
              stale: false,
              startedBy: 'admin@example.org',
              startedAt: '2026-09-14T10:00:00.000Z',
              updatedAt: '2026-09-14T10:00:01.000Z',
              finishedAt: '2026-09-14T10:00:01.000Z',
              total: 1,
              done: 1,
              indexed: 1,
              failed: 0,
              noText: 0,
              missing: 0,
            },
          },
        });
      }
      return jsonResponse(404, { error: `unmocked ${method} ${url}` });
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
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('M365AgentsSection — auto-OCR opt-in', () => {
  it('is off by default, states the served budget, and round-trips into the PUT body', async () => {
    const { calls } = installFetch({ agents: [agentWith([folderSource])] });
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: /editAgent|Edit agent/ }),
    );

    const checkbox = (await screen.findByLabelText(
      'm365AgentAutoOcrLabel',
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    // Helper copy carries the served caps, not hard-coded numbers.
    expect(screen.getByText(/m365AgentAutoOcrHelp/)).toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^(save|Save)$/ }));

    await waitFor(() => {
      expect(
        calls.find(
          (c) =>
            c.method === 'PUT' && c.url === '/api/agent-access/m365-agents',
        ),
      ).toBeDefined();
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ id: AGENT_ID, autoOcr: true });
  });
});

describe('M365AgentsSection — attention rows and Prepare all', () => {
  const scanned = [
    manifestItem('01A', 'BV_Fit2work_signed.pdf'),
    manifestItem('01B', 'BV_GDPR_DE.pdf', { ocrSkipped: 'budget' }),
    manifestItem('01C', 'notes.txt'),
  ];

  it('stacks file name and reason on separate lines and names the OCR skip reason', async () => {
    installFetch({
      agents: [agentWith([folderSource])],
      manifest: manifestWith(scanned),
    });
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentAttentionFiles/ }),
    );
    const name = await screen.findByText('BV_GDPR_DE.pdf');
    const note = screen.getByText('m365ItemOcrSkipped.budget');
    expect(name).not.toBe(note);
    expect(name.parentElement).toBe(note.parentElement);
    expect(name.parentElement?.className).toContain('flex-col');
    expect(name).toHaveAttribute('title', 'BV_GDPR_DE.pdf');
    // A scanned PDF without a skip reason still gets the OCR hint; the
    // .txt is "no text" without one.
    expect(screen.getAllByText('m365ItemNoTextOcr')).toHaveLength(1);
    expect(screen.getByText('m365ItemStatus.noText')).toBeInTheDocument();
  });

  it('does not repeat an item already shown on its single-file source line', async () => {
    const fileSource = {
      ...folderSource,
      sourceId: 'src-2',
      itemId: '01A',
      kind: 'file' as const,
      title: 'BV_Fit2work_signed.pdf',
      status: 'error' as const,
      indexedChunks: 0,
      error: 'Failed to extract text from PDF',
      counts: {
        indexable: 1,
        needsPreparation: 0,
        skipped: 0,
        bytes: 1,
        indexed: 0,
        failed: 1,
      },
    };
    installFetch({
      agents: [agentWith([fileSource])],
      manifest: manifestWith([
        manifestItem('01A', 'BV_Fit2work_signed.pdf', {
          status: 'failed',
          error: 'Failed to extract text from PDF',
        }),
      ]),
    });
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentAttentionFiles/ }),
    );
    await screen.findByText('m365AgentAttentionNone');
    // The source line still reports it, exactly once.
    expect(screen.getAllByText('BV_Fit2work_signed.pdf')).toHaveLength(1);
  });

  it('prepares scanned PDFs one at a time in order after a confirm that states the page cap', async () => {
    const order: string[] = [];
    const { calls } = installFetch({
      agents: [agentWith([folderSource])],
      manifest: manifestWith(scanned),
      prepare: async ({ itemId }) => {
        order.push(itemId);
        return jsonResponse(200, {
          success: true,
          data: { outcome: { status: 'prepared', name: itemId, chars: 500 } },
        });
      },
    });
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentAttentionFiles/ }),
    );
    const button = await screen.findByRole('button', {
      name: /m365PrepareAllButton/,
    });
    fireEvent.click(button);
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining('m365PrepareAllConfirm'),
    );

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(order).toEqual(['01A', '01B']);
    const prepares = calls.filter(
      (c) => c.url === '/api/agent-access/m365-agents/prepare',
    );
    expect(prepares).toHaveLength(2);
    expect(prepares.map((c) => c.body)).toEqual([
      { id: AGENT_ID, driveId: 'b!drive', itemId: '01A' },
      { id: AGENT_ID, driveId: 'b!drive', itemId: '01B' },
    ]);
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain(
      'm365PrepareAllDone',
    );
  });

  it('cancels after the file in flight', async () => {
    let release: (() => void) | null = null;
    const started: string[] = [];
    installFetch({
      agents: [agentWith([folderSource])],
      manifest: manifestWith(scanned),
      prepare: async ({ itemId }) => {
        started.push(itemId);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return jsonResponse(200, {
          success: true,
          data: { outcome: { status: 'prepared', name: itemId, chars: 5 } },
        });
      },
    });
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentAttentionFiles/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /m365PrepareAllButton/ }),
    );
    await screen.findByText(/m365PrepareAllProgress/);
    fireEvent.click(
      screen.getByRole('button', { name: 'm365PrepareAllCancel' }),
    );
    expect(screen.getByText('m365PrepareAllCancelling')).toBeInTheDocument();
    release!();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(started).toEqual(['01A']);
  });

  it('does not prepare a file the confirm declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const { calls } = installFetch({
      agents: [agentWith([folderSource])],
      manifest: manifestWith(scanned),
      prepare: async () => jsonResponse(500, { error: 'should not be called' }),
    });
    renderSection();
    fireEvent.click(
      await screen.findByRole('button', { name: /m365AgentAttentionFiles/ }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /m365PrepareAllButton/ }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(
      calls.filter((c) => c.url === '/api/agent-access/m365-agents/prepare'),
    ).toHaveLength(0);
  });
});

describe('M365AgentsSection — failed job and re-index affordances', () => {
  it('shows the full failure text, keeps indexed content counted, and offers Retry', async () => {
    const { calls } = installFetch({
      agents: [agentWith([folderSource])],
      jobs: {
        [AGENT_ID]: {
          jobId: 'job-1',
          agentId: AGENT_ID,
          status: 'failed',
          mode: 'refresh',
          stale: false,
          startedBy: 'admin@example.org',
          startedAt: '2026-09-14T10:00:00.000Z',
          updatedAt: '2026-09-14T10:00:01.000Z',
          finishedAt: '2026-09-14T10:00:01.000Z',
          total: 8,
          done: 8,
          indexed: 6,
          failed: 2,
          noText: 0,
          missing: 0,
          error: 'The specified blob already exists.',
        },
      },
    });
    renderSection();
    const failure = await screen.findByText(/m365AgentIndexJobFailed/);
    expect(failure).toHaveAttribute(
      'title',
      'The specified blob already exists.',
    );
    expect(failure.className).toContain('line-clamp-2');
    // A failed follow-up run must not read as "never indexed": the
    // source still has 40 chunks.
    expect(
      screen.queryByText('m365AgentStatusNotIndexed'),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'm365AgentIndexRetry' }),
    );
    await waitFor(() => {
      expect(
        calls.find(
          (c) =>
            c.method === 'POST' &&
            c.url === '/api/agent-access/m365-agents/index',
        )?.body,
      ).toEqual({ id: AGENT_ID, mode: 'full' });
    });
  });

  it('counts a source still marked "indexing" by an old run as content when it has chunks', async () => {
    installFetch({
      agents: [agentWith([{ ...folderSource, status: 'indexing' as never }])],
    });
    renderSection();
    await screen.findByText('HR Handbook');
    expect(
      screen.queryByText('m365AgentStatusNotIndexed'),
    ).not.toBeInTheDocument();
  });

  it('renders Re-index all as a bordered secondary button with the agent name titled', async () => {
    installFetch({ agents: [agentWith([folderSource])] });
    renderSection();
    const reindex = await screen.findByRole('button', {
      name: 'm365AgentReindexAll',
    });
    expect(reindex.className).toContain('border-gray-200');
    expect(screen.getByText('HR Handbook')).toHaveAttribute(
      'title',
      'HR Handbook',
    );
  });
});
