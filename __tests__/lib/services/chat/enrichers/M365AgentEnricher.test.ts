// M365AgentEnricher degradation contract: retrieval failure / timeout must
// never hand the user a silent plain model. The persona still applies and
// the model is told the search failed (RETRIEVAL_FAILED_NOTE), with a
// `retrievalFailed` flag on the agent metadata.
import { M365AgentEnricher } from '@/lib/services/chat/enrichers/M365AgentEnricher';
import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';

import { SearchMode } from '@/types/searchMode';

import { createTestChatContext } from '../testUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchM365Agent = vi.hoisted(() => vi.fn());
const logSearch = vi.hoisted(() => vi.fn());
const logSearchError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/m365/agentIndexService', () => ({
  searchM365Agent,
}));
vi.mock('@/lib/services/observability', () => ({
  getAzureMonitorLogger: () => ({ logSearch, logSearchError }),
}));
vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({
      startActiveSpan: (
        _name: string,
        _options: unknown,
        fn: (span: unknown) => Promise<unknown>,
      ) =>
        fn({
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
        }),
    }),
  },
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record: vi.fn() }),
    }),
  },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

const agent = {
  version: 1,
  id: 'm365-abc123def456',
  name: 'Ops Handbook',
  description: '',
  systemPrompt: 'You are the Ops Handbook assistant.',
  chatModelId: null,
  embeddingModelId: 'text-embedding-3-small',
  ragConfig: { topK: 5 },
  sources: [
    {
      sourceId: 'src1',
      driveId: 'd1',
      itemId: 'i1',
      kind: 'file',
      title: 'Handbook.docx',
      webUrl: 'https://example.sharepoint.com/Handbook.docx',
      status: 'indexed',
    },
  ],
  createdBy: 'admin@msf.org',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedBy: 'admin@msf.org',
  updatedAt: '2026-07-29T00:00:00.000Z',
} as unknown as ChatContext['m365Agent'];

const reformulate = vi.fn();
const reformulator = { reformulate } as never;

function makeContext(overrides: Partial<ChatContext> = {}): ChatContext {
  return {
    ...createTestChatContext(),
    m365Agent: agent,
    m365AccessibleSourceIds: ['src1'],
    emitActivity: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reformulate.mockResolvedValue({
    query: 'handbook leave policy',
    source: 'auxiliary',
  });
});

describe('M365AgentEnricher — retrieval failure is loud, not silent', () => {
  it('applies the persona and injects the retrieval-failed note when search throws', async () => {
    searchM365Agent.mockRejectedValue(new Error('index not found'));
    const context = makeContext();

    const result = await new M365AgentEnricher(reformulator).execute(context);

    expect(result.systemPrompt).toContain(
      'You are the Ops Handbook assistant.',
    );
    expect(result.enrichedMessages?.[0]).toMatchObject({ role: 'system' });
    expect(String(result.enrichedMessages?.[0].content)).toMatch(
      /knowledge-base search for this agent FAILED/,
    );
    expect(result.processedContent?.metadata?.m365AgentConfig).toMatchObject({
      agentId: agent!.id,
      retrievalFailed: true,
      retrievalFailureCause: 'error',
      resultCount: 0,
    });
    expect(logSearchError).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'M365_AGENT_RETRIEVAL_FAILED' }),
    );
    expect(context.emitActivity).toHaveBeenCalledWith(
      'chat.activity.knowledgeSearchFailed',
    );
  });

  it('degrades the same way from the pipeline timeout hook', () => {
    const context = makeContext();

    const result = new M365AgentEnricher(reformulator).onTimeout(context);

    expect(result.systemPrompt).toContain(
      'You are the Ops Handbook assistant.',
    );
    expect(String(result.enrichedMessages?.[0].content)).toMatch(/FAILED/);
    expect(result.processedContent?.metadata?.m365AgentConfig).toMatchObject({
      retrievalFailed: true,
      retrievalFailureCause: 'timeout',
    });
  });

  it('leaves a non-M365 context untouched on timeout', () => {
    const context = makeContext({ m365Agent: undefined });
    expect(new M365AgentEnricher(reformulator).onTimeout(context)).toBe(
      context,
    );
  });

  it('keeps the persona and marks retrievalFailed false on a successful search', async () => {
    searchM365Agent.mockResolvedValue([
      {
        title: 'Handbook.docx',
        chunk: 'Leave is 25 days.',
        url: 'https://example.sharepoint.com/Handbook.docx',
        date: '2026-01-01',
      },
    ]);

    const result = await new M365AgentEnricher(reformulator).execute(
      makeContext(),
    );

    expect(result.systemPrompt).toContain(
      'You are the Ops Handbook assistant.',
    );
    expect(String(result.enrichedMessages?.[0].content)).toContain(
      'Available sources',
    );
    expect(result.processedContent?.metadata?.m365AgentConfig).toMatchObject({
      resultCount: 1,
    });
    expect(
      (
        result.processedContent?.metadata?.m365AgentConfig as {
          retrievalFailed?: boolean;
        }
      ).retrievalFailed,
    ).toBeUndefined();
    // The rewritten query is what reaches the index.
    expect(searchM365Agent.mock.calls[0][0]).toBe('handbook leave policy');
  });
});

describe('M365AgentEnricher — query rewrite residency', () => {
  beforeEach(() => {
    searchM365Agent.mockResolvedValue([]);
  });

  it("rewrites in the user's region with the chat model as the fallback", async () => {
    const completeText = vi.fn();
    const context = makeContext({
      user: { ...createTestChatContext().user, region: 'EU' },
    });

    await new M365AgentEnricher(reformulator, { completeText }).execute(
      context,
    );

    const [prompt, routing] = reformulate.mock.calls[0];
    expect(prompt.systemPrompt).toContain('self-contained search query');
    expect(routing.region).toBe('EU');
    expect(routing.textFallback).toEqual(expect.any(Function));
  });

  it('searches with the raw question when no rewrite is produced', async () => {
    reformulate.mockResolvedValue(undefined);
    const context = makeContext({
      messages: [{ role: 'user', content: 'What is the leave policy?' }],
    });

    await new M365AgentEnricher(reformulator).execute(context);

    expect(searchM365Agent.mock.calls[0][0]).toBe('What is the leave policy?');
  });
});

describe('M365AgentEnricher — knowledge search outcome for the tool router', () => {
  const doc = {
    title: 'Handbook.docx',
    date: '2026-01-01T00:00:00.000Z',
    url: 'https://example.sharepoint.com/Handbook.docx',
    chunk: 'Annual leave is 30 days.',
  };

  it('records the retrieved passages', async () => {
    searchM365Agent.mockResolvedValue([doc]);

    const result = await new M365AgentEnricher(reformulator).execute(
      makeContext(),
    );

    expect(result.agentKnowledge).toEqual({
      status: 'searched',
      passages: [{ title: 'Handbook.docx', text: 'Annual leave is 30 days.' }],
    });
  });

  it('records a search that matched nothing as searched-and-empty', async () => {
    searchM365Agent.mockResolvedValue([]);

    const result = await new M365AgentEnricher(reformulator).execute(
      makeContext(),
    );

    expect(result.agentKnowledge).toEqual({ status: 'searched', passages: [] });
  });

  it('records failed — not empty — when the search could not run', async () => {
    searchM365Agent.mockRejectedValue(new Error('index not found'));
    const enricher = new M365AgentEnricher(reformulator);

    expect((await enricher.execute(makeContext())).agentKnowledge).toEqual({
      status: 'failed',
      passages: [],
    });
    expect(enricher.onTimeout(makeContext()).agentKnowledge).toEqual({
      status: 'failed',
      passages: [],
    });
    expect(
      (await enricher.execute(makeContext({ m365AccessibleSourceIds: [] })))
        .agentKnowledge,
    ).toEqual({ status: 'failed', passages: [] });
  });
});

describe('M365AgentEnricher — where the sources came from and how they were found', () => {
  const doc = {
    title: 'Handbook.docx',
    date: '2026-01-01T00:00:00.000Z',
    url: 'https://example.sharepoint.com/Handbook.docx',
    chunk: 'Annual leave is 30 days.',
  };
  const recordsOf = (emitMarker: ReturnType<typeof vi.fn>) =>
    emitMarker.mock.calls.map((call) => call[0] as string);

  it("marks every citation as one of the agent's documents", async () => {
    searchM365Agent.mockResolvedValue([doc, { ...doc, chunk: 'Sick leave.' }]);

    const result = await new M365AgentEnricher(reformulator).execute(
      makeContext(),
    );

    expect(
      result.processedContent?.metadata?.citations?.map(
        (citation) => citation.origin,
      ),
    ).toEqual(['knowledge', 'knowledge']);
  });

  it('leaves a record of the document search: query, passages and documents', async () => {
    searchM365Agent.mockResolvedValue([doc, { ...doc, chunk: 'Sick leave.' }]);
    const emitMarker = vi.fn().mockResolvedValue(undefined);

    await new M365AgentEnricher(reformulator).execute(
      makeContext({ emitMarker }),
    );

    const [record] = recordsOf(emitMarker);
    expect(record).toContain('"name":"knowledge_search"');
    expect(record).toContain('handbook leave policy');
    expect(record).toContain('2 passages from 1 document of the agent');
    expect(record).toContain('"status":"completed"');
  });

  it('records a search that matched nothing as completed, not failed', async () => {
    searchM365Agent.mockResolvedValue([]);
    const emitMarker = vi.fn().mockResolvedValue(undefined);

    await new M365AgentEnricher(reformulator).execute(
      makeContext({ emitMarker }),
    );

    const [record] = recordsOf(emitMarker);
    expect(record).toContain("No matching passages in the agent's documents");
    expect(record).toContain('"status":"completed"');
  });

  it('records a search that could not run as failed', async () => {
    searchM365Agent.mockRejectedValue(new Error('index not found'));
    const emitMarker = vi.fn().mockResolvedValue(undefined);

    await new M365AgentEnricher(reformulator).execute(
      makeContext({ emitMarker }),
    );

    const [record] = recordsOf(emitMarker);
    expect(record).toContain('"status":"failed"');
    expect(record).toContain('could not be searched');
  });
});

describe('M365AgentEnricher — an agent that cannot search the web says so', () => {
  const doc = {
    title: 'Handbook.docx',
    date: '2026-01-01T00:00:00.000Z',
    url: 'https://example.sharepoint.com/Handbook.docx',
    chunk: 'Annual leave is 30 days.',
  };
  const firstSystemMessage = async (overrides: Partial<ChatContext>) => {
    const result = await new M365AgentEnricher(reformulator).execute(
      makeContext(overrides),
    );
    const first = result.enrichedMessages?.[0];
    return first?.role === 'system' ? String(first.content) : '';
  };
  const searching = {
    searchMode: SearchMode.INTELLIGENT,
    m365Agent: { ...agent!, allowWebSearch: true },
  };

  it('forbids web attributions when the owner left web search off', async () => {
    searchM365Agent.mockResolvedValue([doc]);

    expect(
      await firstSystemMessage({ searchMode: SearchMode.INTELLIGENT }),
    ).toContain('No web search is run for this message');
  });

  it('forbids them when the user switched search off, even if the agent allows it', async () => {
    searchM365Agent.mockResolvedValue([doc]);

    expect(
      await firstSystemMessage({ ...searching, searchMode: SearchMode.OFF }),
    ).toContain('No web search is run for this message');
  });

  it('repeats it next to the user message, naming the only citable sources', async () => {
    searchM365Agent.mockResolvedValue([doc]);
    const lastMessage = async (overrides: Partial<ChatContext>) => {
      const result = await new M365AgentEnricher(reformulator).execute(
        makeContext({
          messages: [{ role: 'user', content: 'Minimum wage?' }] as never,
          ...overrides,
        }),
      );
      const messages = result.enrichedMessages ?? [];
      return String(messages[messages.length - 1].content);
    };

    const closed = await lastMessage({ searchMode: SearchMode.INTELLIGENT });
    expect(closed).toContain('NO web search was run for this message');
    expect(closed).toContain('The only sources for this message are [1]');
    expect(closed).toContain('Minimum wage?');
    // When a search may still run, the tool router owns that note.
    expect(await lastMessage(searching)).toBe('Minimum wage?');
  });

  it('leaves the rule out when a web search may run this turn', async () => {
    searchM365Agent.mockResolvedValue([doc]);

    const message = await firstSystemMessage(searching);
    expect(message).toContain('Available sources');
    expect(message).not.toContain('No web search is run');
  });

  it('tells the model when the documents returned nothing', async () => {
    searchM365Agent.mockResolvedValue([]);

    const closed = await firstSystemMessage({
      searchMode: SearchMode.INTELLIGENT,
    });
    expect(closed).toContain('returned no passages');
    expect(closed).toContain('No web search is run for this message');

    const open = await firstSystemMessage(searching);
    expect(open).toContain('returned no passages');
    expect(open).not.toContain('No web search is run');
  });
});
