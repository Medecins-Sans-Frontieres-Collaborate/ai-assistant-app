/**
 * Executor policy: consent-filtered listing (scope probe + cache), unknown
 * tools, budget exhaustion, pre-dispatch args validation, and the
 * never-throw failure mapping (throttling, M365Error kinds). Graph is
 * mocked at the graphApi boundary; catalog data and rendering are real.
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import { M365Error } from '@/lib/services/m365/graphApi';
import { createM365ToolExecutor } from '@/lib/services/m365/tools/executor';
import { clearScopeProbeCache } from '@/lib/services/m365/tools/scopeProbe';
import {
  M365_TOOL_SCOPES,
  M365_TOOL_SPECS,
} from '@/lib/services/m365/tools/toolCatalog';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphJsonMock = vi.hoisted(() => vi.fn());
const graphFetchMock = vi.hoisted(() => vi.fn());
const mintGraphTokenMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ getGraphAccessToken: vi.fn() }));

vi.mock('@/lib/services/m365/graphApi', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/graphApi')>();
  return {
    ...actual,
    graphJson: graphJsonMock,
    graphFetch: graphFetchMock,
    mintGraphToken: mintGraphTokenMock,
  };
});

const req = new NextRequest('http://localhost/api/chat');

function makeSession(id: string): Session {
  return { user: { id, mail: 'me@contoso.com' } } as unknown as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearScopeProbeCache();
});

describe('listTools (scope probe)', () => {
  it('lists all 11 tools when every scope is granted', async () => {
    mintGraphTokenMock.mockResolvedValue('token');
    const executor = createM365ToolExecutor(req, makeSession('u-all'));
    const tools = await executor.listTools();
    expect(tools).toHaveLength(M365_TOOL_SPECS.length);
    expect(tools).toHaveLength(24);
    expect(tools[0]).toEqual({
      name: M365_TOOL_SPECS[0].name,
      description: M365_TOOL_SPECS[0].description,
      inputSchema: M365_TOOL_SPECS[0].inputSchema,
    });
  });

  it('omits chats_search when Chat.Read consent is missing', async () => {
    mintGraphTokenMock.mockImplementation(
      async (_req: unknown, scopes: string[]) => {
        if (scopes.includes('Chat.Read')) {
          throw new M365Error('AADSTS65001', 'consent_missing', 403);
        }
        return 'token';
      },
    );
    const executor = createM365ToolExecutor(req, makeSession('u-partial'));
    const names = (await executor.listTools()).map((tool) => tool.name);
    expect(names).not.toContain('chats_search');
    expect(names).toHaveLength(23);
    expect(names).toContain('calendar_list_events');
    expect(names).toContain('channel_messages');
  });

  it('probes each distinct scope once and caches across listings', async () => {
    mintGraphTokenMock.mockResolvedValue('token');
    const executor = createM365ToolExecutor(req, makeSession('u-cache'));
    await executor.listTools();
    expect(mintGraphTokenMock).toHaveBeenCalledTimes(M365_TOOL_SCOPES.length);
    await executor.listTools();
    // Cached: the second listing mints nothing.
    expect(mintGraphTokenMock).toHaveBeenCalledTimes(M365_TOOL_SCOPES.length);
  });

  it('returns an empty listing when the probe hard-fails', async () => {
    mintGraphTokenMock.mockRejectedValue(
      new M365Error('No Microsoft 365 session', 'not_connected', 401),
    );
    const executor = createM365ToolExecutor(req, makeSession('u-down'));
    expect(await executor.listTools()).toEqual([]);
  });
});

describe('callTool policy', () => {
  it('rejects unknown tools without touching Graph', async () => {
    const executor = createM365ToolExecutor(req, makeSession('u-1'));
    const result = await executor.callTool('mail_send', {});
    expect(result.isError).toBe(true);
    expect(result.resultText).toContain('Unknown tool');
    expect(graphJsonMock).not.toHaveBeenCalled();
  });

  it('returns the friendly limit message when the budget is exhausted', async () => {
    const consumeBudget = vi.fn().mockResolvedValue(false);
    const executor = createM365ToolExecutor(req, makeSession('u-1'), {
      consumeBudget,
    });
    const result = await executor.callTool('teams_list', {});
    expect(result).toEqual({
      resultText:
        'Daily Microsoft 365 tool limit reached — try again tomorrow.',
      isError: true,
    });
    expect(graphJsonMock).not.toHaveBeenCalled();
  });

  it('fails missing/mistyped args before consuming budget', async () => {
    const consumeBudget = vi.fn().mockResolvedValue(true);
    const executor = createM365ToolExecutor(req, makeSession('u-1'), {
      consumeBudget,
    });

    const missing = await executor.callTool('calendar_list_events', {});
    expect(missing.isError).toBe(true);
    expect(missing.resultText).toContain(
      'Missing required argument: startDate',
    );

    const mistyped = await executor.callTool('calendar_list_events', {
      startDate: '2026-08-03',
      endDate: '2026-08-04',
      maxEvents: 'five',
    });
    expect(mistyped.isError).toBe(true);
    expect(mistyped.resultText).toContain('maxEvents must be a number');

    expect(consumeBudget).not.toHaveBeenCalled();
    expect(graphJsonMock).not.toHaveBeenCalled();
  });

  it('maps Graph throttling to the retry-later message', async () => {
    graphJsonMock.mockRejectedValue(
      new M365Error('Request was throttled. Retry later.', 'graph_error', 502),
    );
    const executor = createM365ToolExecutor(req, makeSession('u-1'));
    const result = await executor.callTool('teams_list', {});
    expect(result.isError).toBe(true);
    expect(result.resultText).toBe(
      'Microsoft 365 is throttling requests — try again in a minute.',
    );

    graphJsonMock.mockRejectedValue(
      new M365Error('Graph request failed (429)', 'graph_error', 502),
    );
    const numeric = await executor.callTool('teams_list', {});
    expect(numeric.resultText).toBe(
      'Microsoft 365 is throttling requests — try again in a minute.',
    );
  });

  it('maps M365Error kinds to readable text and never throws', async () => {
    graphJsonMock.mockRejectedValue(new M365Error('missing', 'not_found', 404));
    const executor = createM365ToolExecutor(req, makeSession('u-1'));
    const notFound = await executor.callTool('teams_list', {});
    expect(notFound.isError).toBe(true);
    expect(notFound.resultText).toBe(
      'The requested Microsoft 365 item was not found.',
    );

    graphJsonMock.mockRejectedValue(new Error('socket hang up'));
    const generic = await executor.callTool('teams_list', {});
    expect(generic.isError).toBe(true);
    expect(generic.resultText).toContain('Microsoft 365 request failed');
  });
});
