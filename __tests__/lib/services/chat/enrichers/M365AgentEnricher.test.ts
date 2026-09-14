// M365AgentEnricher degradation contract: retrieval failure / timeout must
// never hand the user a silent plain model. The persona still applies and
// the model is told the search failed (RETRIEVAL_FAILED_NOTE), with a
// `retrievalFailed` flag on the agent metadata.
import { M365AgentEnricher } from '@/lib/services/chat/enrichers/M365AgentEnricher';
import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';

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

const openAIClient = {
  chat: {
    completions: {
      create: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'handbook leave policy' } }],
      }),
    },
  },
} as never;

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
});

describe('M365AgentEnricher — retrieval failure is loud, not silent', () => {
  it('applies the persona and injects the retrieval-failed note when search throws', async () => {
    searchM365Agent.mockRejectedValue(new Error('index not found'));
    const context = makeContext();

    const result = await new M365AgentEnricher(openAIClient).execute(context);

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

    const result = new M365AgentEnricher(openAIClient).onTimeout(context);

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
    expect(new M365AgentEnricher(openAIClient).onTimeout(context)).toBe(
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

    const result = await new M365AgentEnricher(openAIClient).execute(
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
    // The gpt-5 family rejects non-default temperatures.
    expect(openAIClient.chat.completions.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.anything() }),
    );
  });
});
