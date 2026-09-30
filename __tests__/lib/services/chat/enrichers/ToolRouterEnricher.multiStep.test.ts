/**
 * Multi-step web search through the ToolRouterEnricher: when it runs, how it
 * degrades, and what reaches the answering model and the tool strip.
 * (The loop's own rules are covered in tools/multiStepSearch.test.ts.)
 */
import {
  createTestChatContext,
  createTestMessage,
} from '@/__tests__/lib/services/chat/testUtils';
import { ToolRouterEnricher } from '@/lib/services/chat/enrichers/ToolRouterEnricher';
import { fetchArticleText } from '@/lib/services/chat/tools/citedSourceReader';
import { SearchAssessment } from '@/lib/services/chat/tools/searchAssessor';
import { recordTokenUsage } from '@/lib/services/observability/tokenUsageRecorder';
import {
  MULTI_STEP_DEFAULTS,
  ResolvedMultiStepConfig,
} from '@/lib/services/webSearch/config/types';

import { SearchMode } from '@/types/searchMode';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/services/chat/tools/citedSourceReader', () => ({
  readCitedSources: vi.fn(),
  fetchArticleText: vi.fn(),
}));

const consumeToolBudgetMock = vi.fn();
vi.mock('@/lib/services/limits/toolBudget', () => ({
  consumeToolBudget: (...args: unknown[]) => consumeToolBudgetMock(...args),
}));

vi.mock('@/lib/services/observability/tokenUsageRecorder', () => ({
  recordTokenUsage: vi.fn(),
}));

const searxngConfigured = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/services/chat/tools/searxngSearch', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/lib/services/chat/tools/searxngSearch')
    >();
  return { ...actual, isSearxngConfigured: () => searxngConfigured.value };
});

const multiStepConfig = vi.hoisted(() => ({
  value: null as unknown as ResolvedMultiStepConfig,
}));
vi.mock('@/lib/services/webSearch/config/WebSearchConfigService', () => ({
  WebSearchConfigService: {
    getInstance: () => ({
      ensureFresh: vi.fn().mockResolvedValue(undefined),
      getMultiStep: () => multiStepConfig.value,
    }),
  },
}));

const entry = (id: string) => ({
  title: `Title ${id}`,
  url: `https://example.org/${id}`,
  date: '',
  sourceName: 'example.org',
  snippet: `snippet ${id}`,
});

const verdict = (
  partial: Partial<SearchAssessment> & Pick<SearchAssessment, 'verdict'>,
): SearchAssessment => ({
  reason: '',
  queries: [],
  recency: 'any',
  readSources: [],
  question: '',
  exploratory: false,
  useful: [],
  sourceQuality: [],
  caveat: '',
  ...partial,
});

function parseRecords(emitMarker: ReturnType<typeof vi.fn>) {
  return emitMarker.mock.calls
    .map(([marker]) => marker as string)
    .filter((marker) => marker.includes('<<<TOOL_CALL_RECORD>>>'))
    .map((marker) =>
      JSON.parse(
        marker
          .replace(/[\s\S]*<<<TOOL_CALL_RECORD>>>/, '')
          .replace(/<<<END_TOOL_CALL_RECORD>>>[\s\S]*/, ''),
      ),
    );
}

function parseInterims(emitMarker: ReturnType<typeof vi.fn>) {
  return emitMarker.mock.calls
    .map(([marker]) => marker as string)
    .filter((marker) => marker.includes('<<<SEARCH_INTERIM>>>'))
    .map((marker) =>
      JSON.parse(
        marker
          .replace(/[\s\S]*<<<SEARCH_INTERIM>>>/, '')
          .replace(/<<<END_SEARCH_INTERIM>>>[\s\S]*/, ''),
      ),
    );
}

describe('ToolRouterEnricher — multi-step search', () => {
  let enricher: ToolRouterEnricher;
  let router: {
    determineTool: ReturnType<typeof vi.fn>;
    classifyDocumentTrim: ReturnType<typeof vi.fn>;
  };
  let assessor: { assess: ReturnType<typeof vi.fn> };
  let tool: {
    execute: ReturnType<typeof vi.fn>;
    searchSearxngEntries: ReturnType<typeof vi.fn>;
    searxngFallback: ReturnType<typeof vi.fn>;
  };
  let emitMarker: ReturnType<typeof vi.fn>;

  const context = (
    webSearchOptions: Record<string, unknown> = {},
    messages = [
      createTestMessage({
        content: 'current US policy on employment equality',
      }),
    ],
  ) => {
    const ctx = createTestChatContext({
      searchMode: SearchMode.ALWAYS,
      messages,
      model: { id: 'Mistral-Large-3' },
      emitMarker,
    });
    (ctx as any).webSearchOptions = {
      resultCount: 8,
      freshness: 'auto',
      provider: 'searxng',
      ...webSearchOptions,
    };
    (ctx as any).emitActivity = vi.fn().mockResolvedValue(undefined);
    return ctx;
  };

  const lastUserText = (
    result: Awaited<ReturnType<ToolRouterEnricher['execute']>>,
  ) => {
    const messages = result.enrichedMessages ?? result.messages;
    const content = messages[messages.length - 1].content;
    return typeof content === 'string' ? content : JSON.stringify(content);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    consumeToolBudgetMock.mockResolvedValue(true);
    searxngConfigured.value = true;
    multiStepConfig.value = { ...MULTI_STEP_DEFAULTS };

    router = {
      determineTool: vi.fn().mockResolvedValue({
        tools: ['web_search'],
        searchQuery: 'US employment equality policy',
        searchQueries: ['US employment equality policy'],
        searchCategory: 'general',
      }),
      classifyDocumentTrim: vi.fn().mockResolvedValue(null),
    };
    assessor = { assess: vi.fn() };
    emitMarker = vi.fn().mockResolvedValue(undefined);

    enricher = new ToolRouterEnricher(
      router as never,
      { executeWebSearchTool: vi.fn() } as never,
      assessor as never,
    );
    tool = {
      execute: vi.fn().mockResolvedValue({
        text: 'Single-step digest.',
        citations: [{ number: 1, title: 'A', url: 'https://a.example' }],
      }),
      searchSearxngEntries: vi.fn().mockResolvedValue({
        entries: [entry('a'), entry('b'), entry('c')],
        answers: [],
      }),
      searxngFallback: vi.fn().mockResolvedValue({
        text: 'Feed digest.',
        citations: [{ number: 1, title: 'Feed', url: 'https://feed.example' }],
        metadata: { searxngFallback: true },
      }),
    };
    (enricher as any).webSearchTool = tool;
  });

  it('answers after one assessment when the first results suffice — one search, one record', async () => {
    assessor.assess.mockResolvedValue(verdict({ verdict: 'answer' }));

    const result = await enricher.execute(context());

    expect(tool.execute).not.toHaveBeenCalled();
    expect(tool.searchSearxngEntries).toHaveBeenCalledTimes(1);
    expect(assessor.assess).toHaveBeenCalledTimes(1);
    expect(result.processedContent?.metadata?.citations).toHaveLength(3);
    expect(lastUserText(result)).toContain('[1] Title a');
    expect(lastUserText(result)).not.toContain('Search note:');

    const records = parseRecords(emitMarker);
    expect(records).toHaveLength(1);
    expect(records[0].output).toBe('3 sources found');
    expect(records[0].server_label).toBe('Web Search (SearXNG)');
  });

  it('shows the results so far while it works, and again as a step adds to them', async () => {
    assessor.assess
      .mockResolvedValueOnce(
        verdict({
          verdict: 'search',
          queries: ['EEOC guidance'],
          reason: 'thin',
        }),
      )
      .mockResolvedValueOnce(verdict({ verdict: 'answer' }));
    tool.searchSearxngEntries
      .mockResolvedValueOnce({
        entries: [{ ...entry('a'), snippet: 'x'.repeat(400) }, entry('b')],
        answers: [],
      })
      .mockResolvedValueOnce({ entries: [entry('eeoc')], answers: [] });

    await enricher.execute(context());

    const interims = parseInterims(emitMarker);
    expect(interims).toHaveLength(2);
    expect(interims[0]).toMatchObject({
      kind: 'multiStep',
      queries: ['US employment equality policy'],
    });
    expect(interims[0].entries.map((e: { url: string }) => e.url)).toEqual([
      'https://example.org/a',
      'https://example.org/b',
    ]);
    // Brief descriptions only: the echo-back schema bounds the payload.
    expect(interims[0].entries[0].snippet.length).toBeLessThanOrEqual(220);
    expect(interims[1].entries).toHaveLength(3);
    expect(interims[1].queries).toEqual([
      'US employment equality policy',
      'EEOC guidance',
    ]);
  });

  it('debits the daily search quota once for a multi-step question', async () => {
    assessor.assess
      .mockResolvedValueOnce(
        verdict({
          verdict: 'search',
          queries: ['EEOC enforcement guidance'],
          reason: 'primary source missing',
        }),
      )
      .mockResolvedValueOnce(
        verdict({ verdict: 'read', readSources: [4], reason: 'need the text' }),
      )
      .mockResolvedValueOnce(verdict({ verdict: 'answer', useful: [4, 1] }));
    tool.searchSearxngEntries
      .mockResolvedValueOnce({
        entries: [entry('a'), entry('b'), entry('c')],
        answers: [],
      })
      .mockResolvedValueOnce({ entries: [entry('eeoc')], answers: [] });
    vi.mocked(fetchArticleText).mockResolvedValue({
      title: 'EEOC',
      text: 'Title VII of the Civil Rights Act prohibits employment discrimination. '.repeat(
        8,
      ),
    });

    const result = await enricher.execute(context());

    expect(consumeToolBudgetMock).toHaveBeenCalledTimes(1);
    expect(tool.searchSearxngEntries).toHaveBeenCalledTimes(2);
    expect(tool.searchSearxngEntries.mock.calls[1][0]).toEqual([
      'EEOC enforcement guidance',
    ]);
    expect(fetchArticleText).toHaveBeenCalledWith(
      'https://example.org/eeoc',
      expect.any(Number),
    );

    const text = lastUserText(result);
    // The assessor's pick leads, with the text read from its page.
    expect(text).toContain('[1] Title eeoc');
    expect(text).toContain('Text read from this page:');
    expect(text).toContain('Title VII of the Civil Rights Act');
    expect(result.processedContent?.metadata?.citations?.[0]).toMatchObject({
      number: 1,
      url: 'https://example.org/eeoc',
    });

    const records = parseRecords(emitMarker);
    expect(records.map((record) => record.output)).toEqual([
      '3 sources found',
      '1 new source found',
      '1 of 1 page read',
    ]);
    expect(JSON.parse(records[1].arguments)).toEqual({
      query: 'EEOC enforcement guidance',
      why: 'primary source missing',
    });
    expect(JSON.parse(records[2].arguments)).toEqual({
      pages: 'example.org',
      why: 'need the text',
    });
    expect(new Set(records.map((record) => record.id)).size).toBe(3);
  });

  it('passes the conversation and the admin-selected assessor, and meters the call', async () => {
    multiStepConfig.value = {
      ...MULTI_STEP_DEFAULTS,
      assessorModelId: 'gpt-5.4-mini',
    };
    assessor.assess.mockImplementation(async (_input, options) => {
      options.onUsage(
        { promptTokens: 1200, completionTokens: 80, totalTokens: 1280 },
        { id: 'gpt-5.4-mini' },
        'EU',
      );
      return verdict({ verdict: 'answer' });
    });

    await enricher.execute(
      context({}, [
        createTestMessage({
          content:
            'I am researching The Anatomy of Melancholy, 1621 first edition',
        }),
        createTestMessage({
          role: 'assistant',
          content: 'A famous work by Robert Burton.',
        }),
        createTestMessage({
          content: 'can you find a copy of this book for sale?',
        }),
      ]),
    );

    const [input, options] = assessor.assess.mock.calls[0];
    expect(input.question).toBe('can you find a copy of this book for sale?');
    expect(input.recentContext).toEqual([
      {
        role: 'user',
        text: 'I am researching The Anatomy of Melancholy, 1621 first edition',
      },
      { role: 'assistant', text: 'A famous work by Robert Burton.' },
    ]);
    expect(options.modelId).toBe('gpt-5.4-mini');
    // The test user is a US user: their own region's account is tried first.
    expect(options.region).toBe('US');
    expect(recordTokenUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        promptTokens: 1200,
        totalTokens: 1280,
        modelId: 'gpt-5.4-mini',
        // Recorded against the account that actually served the call.
        region: 'EU',
      }),
      expect.objectContaining({ id: 'gpt-5.4-mini' }),
      expect.anything(),
      false,
      undefined,
    );
  });

  it('tells the model to ask the clarifying question', async () => {
    assessor.assess.mockResolvedValue(
      verdict({
        verdict: 'ask_user',
        question: 'Which edition are you looking for?',
      }),
    );
    const text = lastUserText(await enricher.execute(context()));
    expect(text).toContain('Search note:');
    expect(text).toContain('Which edition are you looking for?');
  });

  it('asks the question even when nothing at all was found', async () => {
    tool.searchSearxngEntries.mockResolvedValue({ entries: [], answers: [] });
    assessor.assess.mockResolvedValue(
      verdict({ verdict: 'ask_user', question: 'Which country do you mean?' }),
    );

    const result = await enricher.execute(context());

    expect(tool.searxngFallback).not.toHaveBeenCalled();
    expect(lastUserText(result)).toContain('Which country do you mean?');
    expect(result.processedContent?.metadata?.citations ?? []).toHaveLength(0);
    // The step record is not doubled by the empty-result path.
    expect(parseRecords(emitMarker)).toHaveLength(1);
  });

  it('reports a give-up honestly instead of answering as if it had found it', async () => {
    assessor.assess.mockResolvedValue(
      verdict({ verdict: 'give_up', reason: 'no seller lists this edition' }),
    );
    const text = lastUserText(await enricher.execute(context()));
    expect(text).toContain('did not find what was asked');
    expect(text).toContain('no seller lists this edition');
  });

  it('labels source quality for the answering model', async () => {
    assessor.assess.mockResolvedValue(
      verdict({
        verdict: 'answer',
        useful: [2, 1],
        sourceQuality: [
          { n: 2, tier: 'primary' },
          { n: 1, tier: 'unreliable' },
        ],
        caveat: 'Only the agency page is authoritative',
      }),
    );
    const text = lastUserText(await enricher.execute(context()));
    expect(text).toContain(
      '[1] Title b (example.org) — source type: official or original source',
    );
    expect(text).toContain(
      '[2] Title a (example.org) — source type: low reliability',
    );
    expect(text).toContain(
      'Note on these sources: Only the agency page is authoritative',
    );
  });

  it('falls back to the news feeds when nothing is found after every step', async () => {
    tool.searchSearxngEntries.mockResolvedValue({ entries: [], answers: [] });
    assessor.assess.mockResolvedValue(verdict({ verdict: 'give_up' }));

    const result = await enricher.execute(context());

    expect(tool.searxngFallback).toHaveBeenCalledTimes(1);
    expect(lastUserText(result)).toContain('Feed digest.');
  });

  it('falls back to the news feeds when the instance is down — no assessor call', async () => {
    tool.searchSearxngEntries.mockRejectedValue(
      new Error('SearXNG in failure cooldown'),
    );

    const result = await enricher.execute(context());

    expect(assessor.assess).not.toHaveBeenCalled();
    expect(tool.searxngFallback).toHaveBeenCalledTimes(1);
    expect(lastUserText(result)).toContain('Feed digest.');
    const records = parseRecords(emitMarker);
    expect(records).toHaveLength(1);
    expect(records[0].output).toContain('news feeds used instead');
  });

  it('degrades to the plain search result when no assessor answers', async () => {
    assessor.assess.mockResolvedValue(null);
    const result = await enricher.execute(context());
    expect(result.processedContent?.metadata?.citations).toHaveLength(3);
    expect(lastUserText(result)).not.toContain('Search note:');
  });

  it('takes no further step and emits nothing more once the stage is aborted', async () => {
    const stage = new AbortController();
    assessor.assess.mockImplementation(async () => {
      stage.abort();
      return verdict({ verdict: 'search', queries: ['another query'] });
    });
    const ctx = context();
    (ctx as any).stageSignal = stage.signal;

    await enricher.execute(ctx);

    expect(assessor.assess).toHaveBeenCalledTimes(1);
    expect(tool.searchSearxngEntries).toHaveBeenCalledTimes(1);
    expect(parseRecords(emitMarker)).toHaveLength(1);
  });

  describe('runs single-step', () => {
    const expectSingleStep = async (ctx: ReturnType<typeof context>) => {
      const result = await enricher.execute(ctx);
      expect(tool.execute).toHaveBeenCalledTimes(1);
      expect(tool.searchSearxngEntries).not.toHaveBeenCalled();
      expect(assessor.assess).not.toHaveBeenCalled();
      expect(lastUserText(result)).toContain('Single-step digest.');
    };

    it('when an admin disabled multi-step search', async () => {
      multiStepConfig.value = { ...MULTI_STEP_DEFAULTS, enabled: false };
      await expectSingleStep(context());
    });

    it('when the user switched it off', async () => {
      await expectSingleStep(context({ multiStep: false }));
    });

    it('on any provider other than SearXNG', async () => {
      await expectSingleStep(context({ provider: 'google-news' }));
    });

    it('where the SearXNG instance is not configured', async () => {
      searxngConfigured.value = false;
      await expectSingleStep(context());
    });

    it('when the enricher has no assessor', async () => {
      enricher = new ToolRouterEnricher(
        router as never,
        { executeWebSearchTool: vi.fn() } as never,
      );
      (enricher as any).webSearchTool = tool;
      await expectSingleStep(context());
    });
  });
});
