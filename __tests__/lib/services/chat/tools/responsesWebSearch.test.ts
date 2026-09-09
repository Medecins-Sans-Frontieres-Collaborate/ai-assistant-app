/**
 * Tests for the 'bing-responses' web-search executor: the native web_search
 * tool on the Azure OpenAI Responses API.
 */
import {
  buildCitedSearchResult,
  executeResponsesWebSearch,
} from '@/lib/services/chat/tools/responsesWebSearch';

import { env } from '@/config/environment';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate, mockGetOpenAIClient } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockGetOpenAIClient = vi
    .fn()
    .mockResolvedValue({ responses: { create: mockCreate } });
  return { mockCreate, mockGetOpenAIClient };
});

// Constructor mocks must be `function`s — `new` on an arrow throws.
vi.mock('@azure/ai-projects', () => ({
  AIProjectClient: vi.fn().mockImplementation(function () {
    return { getOpenAIClient: mockGetOpenAIClient };
  }),
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

describe('buildCitedSearchResult', () => {
  it('inserts a marker at the annotation end index and returns the citation', () => {
    const result = buildCitedSearchResult([
      {
        text: 'Solar output doubled last year. More below.',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.com/solar',
            title: 'Solar report',
            start_index: 0,
            end_index: 31,
          },
        ],
      },
    ]);

    expect(result.text).toBe('Solar output doubled last year.[1] More below.');
    expect(result.citations).toEqual([
      {
        number: 1,
        title: 'Solar report',
        url: 'https://example.com/solar',
        date: '',
      },
    ]);
  });

  it('numbers by first appearance even when annotations arrive out of order', () => {
    const result = buildCitedSearchResult([
      {
        text: 'First claim. Second claim.',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.com/b',
            title: 'B',
            start_index: 13,
            end_index: 26,
          },
          {
            type: 'url_citation',
            url: 'https://example.com/a',
            title: 'A',
            start_index: 0,
            end_index: 12,
          },
        ],
      },
    ]);

    expect(result.text).toBe('First claim.[1] Second claim.[2]');
    expect(result.citations.map((c) => c.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('dedupes repeated URLs into one citation reused at each position', () => {
    const result = buildCitedSearchResult([
      {
        text: 'Claim one. Claim two. Claim three.',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.com/shared',
            title: 'Shared',
            start_index: 0,
            end_index: 10,
          },
          {
            type: 'url_citation',
            url: 'https://example.com/other',
            title: 'Other',
            start_index: 11,
            end_index: 21,
          },
          {
            type: 'url_citation',
            url: 'https://example.com/shared',
            title: 'Shared',
            start_index: 22,
            end_index: 34,
          },
        ],
      },
    ]);

    expect(result.text).toBe('Claim one.[1] Claim two.[2] Claim three.[1]');
    expect(result.citations).toHaveLength(2);
  });

  it('continues numbering across content parts and joins their text', () => {
    const result = buildCitedSearchResult([
      {
        text: 'Part one claim.',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.com/one',
            title: 'One',
            start_index: 0,
            end_index: 15,
          },
        ],
      },
      {
        text: 'Part two claim.',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.com/two',
            title: 'Two',
            start_index: 0,
            end_index: 15,
          },
        ],
      },
    ]);

    expect(result.text).toBe('Part one claim.[1]\n\nPart two claim.[2]');
    expect(result.citations).toHaveLength(2);
  });

  it('returns plain text and no citations when there are no annotations', () => {
    const result = buildCitedSearchResult([
      { text: 'No sources here.', annotations: [] },
    ]);
    expect(result).toEqual({ text: 'No sources here.', citations: [] });
  });

  it('clamps an end index past the text length to the end', () => {
    const result = buildCitedSearchResult([
      {
        text: 'Short.',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.com/x',
            title: 'X',
            start_index: 0,
            end_index: 999,
          },
        ],
      },
    ]);
    expect(result.text).toBe('Short.[1]');
  });

  it('suppresses an adjacent duplicate marker for the same URL', () => {
    const result = buildCitedSearchResult([
      {
        text: 'One claim.',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.com/dup',
            title: 'Dup',
            start_index: 0,
            end_index: 10,
          },
          {
            type: 'url_citation',
            url: 'https://example.com/dup',
            title: 'Dup',
            start_index: 0,
            end_index: 10,
          },
        ],
      },
    ]);
    expect(result.text).toBe('One claim.[1]');
  });

  it('ignores non-url_citation annotations and entries without a url', () => {
    const result = buildCitedSearchResult([
      {
        text: 'Mixed annotations.',
        annotations: [
          {
            type: 'file_citation',
            url: 'https://example.com/file',
            start_index: 0,
            end_index: 5,
          },
          {
            type: 'url_citation',
            url: '',
            start_index: 0,
            end_index: 5,
          },
        ],
      },
    ]);
    expect(result).toEqual({ text: 'Mixed annotations.', citations: [] });
  });
});

describe('executeResponsesWebSearch', () => {
  const originalEndpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;

  beforeEach(() => {
    vi.clearAllMocks();
    (env as any).AZURE_AI_FOUNDRY_ENDPOINT =
      'https://unit-test.services.ai.azure.com/api/projects/test';
    mockCreate.mockResolvedValue({
      output: [
        { type: 'web_search_call', status: 'completed' },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Grounded answer.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://example.com/source',
                  title: 'Source',
                  start_index: 0,
                  end_index: 16,
                },
              ],
            },
          ],
        },
      ],
    });
  });

  afterAll(() => {
    (env as any).AZURE_AI_FOUNDRY_ENDPOINT = originalEndpoint;
  });

  it('calls the Responses API with the web_search tool, stateless, low effort', async () => {
    const result = await executeResponsesWebSearch({
      searchQuery: 'renewable energy trends',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const request = mockCreate.mock.calls[0][0];
    expect(request.model).toBe(env.WEB_SEARCH_RESPONSES_MODEL);
    expect(request.tools).toEqual([{ type: 'web_search' }]);
    expect(request.store).toBe(false);
    expect(request.reasoning).toEqual({ effort: 'low' });
    expect(request.input).toContain(
      'Information need: renewable energy trends',
    );

    expect(result.text).toBe('Grounded answer.[1]');
    expect(result.citations).toEqual([
      {
        number: 1,
        title: 'Source',
        url: 'https://example.com/source',
        date: '',
      },
    ]);
  });

  it('raises reasoning effort for deep searches', async () => {
    await executeResponsesWebSearch({
      searchQuery: 'compare battery chemistries',
      deep: true,
    });
    expect(mockCreate.mock.calls[0][0].reasoning).toEqual({
      effort: 'medium',
    });
  });

  it('carries resultCount and freshness into the instruction text', async () => {
    await executeResponsesWebSearch({
      searchQuery: 'india protests',
      resultCount: 12,
      freshness: 'week',
    });
    const input = mockCreate.mock.calls[0][0].input;
    expect(input).toContain('up to 12 distinct, high-quality sources');
    expect(input).toContain('within the past week');
  });

  it("omits the freshness line when freshness is 'any'", async () => {
    await executeResponsesWebSearch({
      searchQuery: 'india protests',
      freshness: 'any',
    });
    const input = mockCreate.mock.calls[0][0].input;
    expect(input).not.toContain('within the past');
  });

  it('returns an empty result when the response has no message output', async () => {
    mockCreate.mockResolvedValue({
      output: [{ type: 'web_search_call', status: 'completed' }],
    });
    const result = await executeResponsesWebSearch({
      searchQuery: 'anything',
    });
    expect(result).toEqual({ text: '', citations: [] });
  });

  it('propagates API failures to the caller', async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error('deployment not found'), { status: 404 }),
    );
    await expect(
      executeResponsesWebSearch({ searchQuery: 'anything' }),
    ).rejects.toThrow('deployment not found');
  });
});
