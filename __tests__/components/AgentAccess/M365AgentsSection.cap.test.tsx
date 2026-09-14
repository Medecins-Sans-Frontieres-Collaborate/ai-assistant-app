/**
 * Per-agent document cap override (local-admin flex up to the local
 * ceiling, global admins above it) and the plan-view trim tools: file
 * checkboxes, "Keep newest N", sort by size, over-cap routing.
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
const DEFAULT_CAP = 50;

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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
  excludedItemIds: [] as string[],
  lastIndexedAt: '2026-09-14T04:02:46.000Z',
};

const agentWith = (
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
    sources: [folderSource],
    createdBy: 'admin@example.org',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedBy: 'admin@example.org',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  } as AdminStoredM365Agent['agent'],
});

interface PlanItem {
  itemId: string;
  name: string;
  size?: number;
  lastModified?: string;
  excluded?: boolean;
}

const planItem = (item: PlanItem) => ({
  itemId: item.itemId,
  driveId: 'b!drive',
  name: item.name,
  path: '',
  parentItemId: '01FOLDER',
  size: item.size ?? 1000,
  webUrl: `https://contoso.sharepoint.com/Policies/${item.name}`,
  lastModified: item.lastModified,
  tier: item.excluded ? 'skipped' : 'indexable',
  ...(item.excluded ? { reason: 'excluded' } : {}),
});

interface Scenario {
  agents: AdminStoredM365Agent[];
  isGlobalAdmin?: boolean;
  /** Indexable documents the folder expands to (drives the cap meter). */
  documents: number;
  /** Explicit file rows in the plan; when absent, none are listed. */
  items?: PlanItem[];
  put?: (body: Record<string, unknown>) => Response;
}

function installFetch(scenario: Scenario) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
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
            maxDocuments: DEFAULT_CAP,
            maxBytes: 512 * 1024 * 1024,
            ocrMaxPages: 120,
            autoOcrMaxPagesPerRun: 150,
            autoOcrMaxPagesPerFile: 40,
            maxDocumentsCeilings: { localAdmin: 100, globalAdmin: 200 },
            isGlobalAdmin: scenario.isGlobalAdmin ?? false,
            jobs: {},
          },
        });
      }
      if (url === '/api/agent-access/m365-agents' && method === 'PUT') {
        if (scenario.put) return scenario.put(body);
        return jsonResponse(200, {
          success: true,
          data: { m365Agent: scenario.agents[0].agent, etag: '"etag-2"' },
        });
      }
      if (url === '/api/agent-access/m365-agents/plan') {
        // The server clamps a requested cap to the caller's ceiling and
        // answers with the EFFECTIVE cap.
        const ceiling = scenario.isGlobalAdmin ? 200 : 100;
        const effective = Math.min(
          typeof body?.maxDocuments === 'number'
            ? body.maxDocuments
            : DEFAULT_CAP,
          ceiling,
        );
        const excluded = new Set<string>(
          body?.sources?.[0]?.excludedItemIds ?? [],
        );
        const items = (scenario.items ?? []).map((item) =>
          planItem({ ...item, excluded: excluded.has(item.itemId) }),
        );
        const listedIndexable = items.filter(
          (i) => i.tier === 'indexable',
        ).length;
        const total = scenario.items ? listedIndexable : scenario.documents;
        return jsonResponse(200, {
          success: true,
          data: {
            plans: [
              {
                driveId: 'b!drive',
                itemId: '01FOLDER',
                missing: false,
                truncated: false,
                folders: [],
                items,
                counts: {
                  indexable: total,
                  needsPreparation: 0,
                  skipped: items.length - listedIndexable,
                  bytes: total * 1000,
                },
              },
            ],
            totalDocuments: total,
            totalBytes: total * 1000,
            maxDocuments: effective,
            maxBytes: 512 * 1024 * 1024,
            overDocumentCap: total > effective,
            overByteCap: false,
          },
        });
      }
      if (url.startsWith('/api/agent-access/m365-agents/manifest')) {
        return jsonResponse(200, { success: true, data: { manifest: null } });
      }
      if (url.startsWith('/api/agent-access/m365-agents/changes')) {
        return jsonResponse(200, {
          success: true,
          data: { preview: null, lastIndexedAt: null },
        });
      }
      return jsonResponse(404, { error: `unmocked ${method} ${url}` });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  const planCalls = () =>
    calls.filter((c) => c.url === '/api/agent-access/m365-agents/plan');
  return { calls, planCalls };
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

async function openEditor() {
  fireEvent.click(
    await screen.findByRole('button', { name: /editAgent|Edit agent/ }),
  );
}

/** Waits until a plan request whose body matches has been answered. */
async function waitForPlan(
  planCalls: () => Array<{ body?: any }>,
  predicate: (body: any) => boolean,
) {
  await waitFor(
    () => {
      expect(planCalls().some((c) => predicate(c.body))).toBe(true);
    },
    { timeout: 3000 },
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

describe('document cap override — local admin', () => {
  it('offers to raise to the need rounded up to 10 (capped at 100), confirms, re-plans with the new cap and saves it', async () => {
    const { calls, planCalls } = installFetch({
      agents: [agentWith()],
      documents: 63,
    });
    renderSection();
    await openEditor();
    await waitForPlan(planCalls, (b) => b.maxDocuments === undefined);

    const raise = await screen.findByRole('button', {
      name: 'm365CapRaiseButton',
    });
    expect(
      screen.queryByText('m365CapNeedsGlobalAdmin'),
    ).not.toBeInTheDocument();
    fireEvent.click(raise);
    expect(window.confirm).toHaveBeenCalledWith('m365CapRaiseConfirm');
    // 63 → 70: rounded up to the next ten, under the local ceiling.
    await waitForPlan(planCalls, (b) => b.maxDocuments === 70);
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'm365CapRaiseButton' }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText('m365CapOverrideNote')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^(save|Save)$/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({
      id: AGENT_ID,
      maxDocumentsOverride: 70,
    });
  });

  it('does not raise when the confirm is declined', async () => {
    const { planCalls } = installFetch({
      agents: [agentWith()],
      documents: 63,
    });
    vi.mocked(window.confirm).mockReturnValue(false);
    renderSection();
    await openEditor();
    fireEvent.click(
      await screen.findByRole('button', { name: 'm365CapRaiseButton' }),
    );
    await new Promise((r) => setTimeout(r, 600));
    expect(planCalls().some((c) => c.body?.maxDocuments !== undefined)).toBe(
      false,
    );
  });

  it('caps the raise at the local ceiling and says a global admin must go further', async () => {
    const { planCalls } = installFetch({
      agents: [agentWith()],
      documents: 130,
    });
    renderSection();
    await openEditor();
    expect(
      await screen.findByText('m365CapNeedsGlobalAdmin'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'm365CapRaiseButton' }));
    await waitForPlan(planCalls, (b) => b.maxDocuments === 100);
    // Still over cap at 100: the need-a-global-admin line stays.
    expect(screen.getByText('m365CapNeedsGlobalAdmin')).toBeInTheDocument();
  });

  it('renders the server refusal for a cap above the role ceiling', async () => {
    installFetch({
      agents: [agentWith({ maxDocumentsOverride: 80 } as never)],
      documents: 10,
      put: () =>
        jsonResponse(400, {
          success: false,
          error: 'Local admins may set at most 100 documents',
          code: 'M365_CAP_ABOVE_ROLE',
        }),
    });
    renderSection();
    await openEditor();
    // Make it dirty so the PUT goes out.
    fireEvent.change(await screen.findByLabelText('m365AgentNameLabel'), {
      target: { value: 'HR Handbook v2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^(save|Save)$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local admins may set at most 100 documents',
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('resets an override to the default and saves null', async () => {
    const { calls } = installFetch({
      agents: [agentWith({ maxDocumentsOverride: 80 } as never)],
      documents: 10,
    });
    renderSection();
    await openEditor();
    fireEvent.click(
      await screen.findByRole('button', { name: 'm365CapResetDefault' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /^(save|Save)$/ }));
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
    });
    expect(
      calls.find((c) => c.method === 'PUT')!.body.maxDocumentsOverride,
    ).toBe(null);
  });

  it('shows the override on the agent row', async () => {
    installFetch({
      agents: [
        agentWith({
          maxDocumentsOverride: 80,
          maxDocumentsOverrideBy: 'lead@example.org',
        } as never),
      ],
      documents: 10,
    });
    renderSection();
    expect(await screen.findByText('m365AgentLimitBadge')).toBeInTheDocument();
  });
});

describe('document cap override — global admin', () => {
  it('takes a numeric limit and re-plans with it', async () => {
    const { planCalls } = installFetch({
      agents: [agentWith()],
      isGlobalAdmin: true,
      documents: 130,
    });
    renderSection();
    await openEditor();
    const input = (await screen.findByLabelText(
      'm365CapRaiseInputLabel',
    )) as HTMLInputElement;
    expect(input.max).toBe('200');
    expect(
      screen.queryByRole('button', { name: 'm365CapRaiseButton' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('m365CapNeedsGlobalAdmin'),
    ).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'm365CapRaiseApply' }));
    expect(window.confirm).toHaveBeenCalledWith('m365CapRaiseConfirm');
    await waitForPlan(planCalls, (b) => b.maxDocuments === 150);
    // Within the cap now: the raise control is gone, the note stays.
    await waitFor(() => {
      expect(
        screen.queryByLabelText('m365CapRaiseInputLabel'),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText('m365CapOverrideNote')).toBeInTheDocument();
  });

  it('clamps a value above the global ceiling to the ceiling', async () => {
    const { planCalls } = installFetch({
      agents: [agentWith()],
      isGlobalAdmin: true,
      documents: 130,
    });
    renderSection();
    await openEditor();
    const input = await screen.findByLabelText('m365CapRaiseInputLabel');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'm365CapRaiseApply' }));
    await waitForPlan(planCalls, (b) => b.maxDocuments === 200);
  });
});

describe('plan-view trim tools', () => {
  const files: PlanItem[] = [
    {
      itemId: 'A',
      name: 'a.pdf',
      size: 500,
      lastModified: '2026-01-01T00:00:00Z',
    },
    {
      itemId: 'B',
      name: 'b.pdf',
      size: 9000,
      lastModified: '2026-03-01T00:00:00Z',
    },
    {
      itemId: 'C',
      name: 'c.pdf',
      size: 2000,
      lastModified: '2026-02-01T00:00:00Z',
    },
  ];

  it('unticking a file adds its id to excludedItemIds and re-plans; ticking removes it', async () => {
    const { planCalls } = installFetch({
      agents: [agentWith()],
      documents: 3,
      items: files,
    });
    renderSection();
    await openEditor();
    await waitForPlan(planCalls, (b) => Array.isArray(b.sources));
    fireEvent.click(
      await screen.findByRole('button', { name: 'm365PlanShowDetails' }),
    );
    const boxes = (await screen.findAllByRole('checkbox', {
      name: 'm365PlanIncludeFile',
    })) as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    fireEvent.click(boxes[0]);
    await waitForPlan(planCalls, (b) =>
      (b.sources?.[0]?.excludedItemIds ?? []).includes('A'),
    );
    // The unticked file stays listed, unchecked, so it can come back.
    const after = (await screen.findAllByRole('checkbox', {
      name: 'm365PlanIncludeFile',
    })) as HTMLInputElement[];
    const unticked = after.find((box) => !box.checked)!;
    expect(unticked).toBeDefined();
    fireEvent.click(unticked);
    await waitForPlan(
      planCalls,
      (b) =>
        b.sources?.[0]?.excludedItemIds &&
        b.sources[0].excludedItemIds.length === 0 &&
        planCalls().length >= 3,
    );
  });

  it('"Keep newest N" excludes the oldest files after a confirm that states the counts', async () => {
    // Over cap: 3 documents against a stored override of 2 (the plan mock
    // derives overDocumentCap from total > effective cap).
    const { planCalls } = installFetch({
      agents: [agentWith({ maxDocumentsOverride: 2 } as never)],
      documents: 3,
      items: files,
    });
    renderSection();
    await openEditor();
    await waitForPlan(planCalls, (b) => b.maxDocuments === 2);
    // Over cap → the largest source auto-expands with the trim hint.
    expect(await screen.findAllByText('m365PlanTrimHint')).not.toHaveLength(0);
    fireEvent.click(
      await screen.findByRole('button', { name: 'm365PlanKeepNewest' }),
    );
    expect(window.confirm).toHaveBeenCalledWith('m365PlanKeepNewestConfirm');
    await waitFor(
      () => {
        const last = planCalls().at(-1)?.body;
        expect(last?.sources?.[0]?.excludedItemIds).toEqual(['A']);
      },
      { timeout: 3000 },
    );
    // Now within the cap: "Include all again" is offered instead.
    expect(
      await screen.findByRole('button', { name: 'm365PlanIncludeAll' }),
    ).toBeInTheDocument();
  });

  it('sorts the file list by size, largest first', async () => {
    const { planCalls } = installFetch({
      agents: [agentWith()],
      documents: 3,
      items: files,
    });
    const { container } = renderSection();
    await openEditor();
    await waitForPlan(planCalls, (b) => Array.isArray(b.sources));
    fireEvent.click(
      await screen.findByRole('button', { name: 'm365PlanShowDetails' }),
    );
    await screen.findAllByRole('checkbox', { name: 'm365PlanIncludeFile' });
    const names = () =>
      Array.from(
        container.querySelectorAll('input[aria-label="m365PlanIncludeFile"]'),
      ).map((box) =>
        box.parentElement?.querySelector('span[title]')?.getAttribute('title'),
      );
    expect(names()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    fireEvent.change(screen.getByLabelText('m365PlanSortLabel'), {
      target: { value: 'size' },
    });
    expect(names()).toEqual(['b.pdf', 'c.pdf', 'a.pdf']);
  });
});
