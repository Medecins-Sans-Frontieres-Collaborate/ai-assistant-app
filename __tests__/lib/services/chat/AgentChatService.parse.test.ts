import { AgentChatService } from '@/lib/services/chat/AgentChatService';

import { OpenAIModel } from '@/types/openai';

import { describe, expect, it, vi } from 'vitest';

/**
 * The search sub-call's inner Foundry stream carries AGENT_ACTIVITY markers
 * and a terminal metadata block. The parser must forward activities (live
 * progress), strip ALL marker wire-format from the returned text (it gets
 * merged into a model prompt), and parse metadata even when the block is
 * split across network reads.
 */

function streamResponseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream);
}

const model = {
  id: 'gpt-5.2',
  name: 'GPT-5.2',
  maxLength: 128000,
  tokenLimit: 16384,
  provider: 'openai',
  agentId: 'agent-1',
} as OpenAIModel;

const user = { id: 'u1', mail: 'u@example.org' } as any;

async function runSearch(
  chunks: string[],
  onActivity?: (key: string, params?: Record<string, string>) => void,
) {
  const service = new AgentChatService();
  (service as any).aiFoundryAgentHandler = {
    handleAgentChat: vi
      .fn()
      .mockResolvedValue(streamResponseFromChunks(chunks)),
  };
  return service.executeWebSearchTool({
    searchQuery: 'India protests 2026',
    model,
    user,
    onActivity,
  });
}

describe('AgentChatService — inner stream parsing', () => {
  it('forwards activity payloads and strips markers from the text', async () => {
    const activities: Array<[string, Record<string, string> | undefined]> = [];
    const result = await runSearch(
      [
        '\n\n<<<AGENT_ACTIVITY>>>{"key":"chat.activity.searchingWeb"}<<<END_AGENT_ACTIVITY>>>\n\n',
        '\n\n<<<AGENT_ACTIVITY>>>{"key":"chat.activity.usingNamedTool","params":{"tool":"bing"}}<<<END_AGENT_ACTIVITY>>>\n\n',
        'Protests summary text.',
      ],
      (key, params) => activities.push([key, params]),
    );

    expect(activities).toEqual([
      ['chat.activity.searchingWeb', undefined],
      ['chat.activity.usingNamedTool', { tool: 'bing' }],
    ]);
    expect(result.text).toBe('Protests summary text.');
    expect(result.text).not.toContain('<<<');
  });

  it('parses a metadata block split across network reads', async () => {
    const metadata = JSON.stringify({
      citations: [
        { number: 1, title: 'Source', url: 'https://s.example', date: '2026' },
      ],
    });
    const block = `\n\n<<<METADATA_START>>>${metadata}<<<METADATA_END>>>`;
    const splitAt = block.indexOf('METADATA_END') - 4;

    const result = await runSearch([
      'Answer text.',
      block.slice(0, splitAt),
      block.slice(splitAt),
    ]);

    expect(result.text).toBe('Answer text.');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0].url).toBe('https://s.example');
  });

  it('handles a marker split across reads without leaking fragments', async () => {
    const marker =
      '<<<AGENT_ACTIVITY>>>{"key":"chat.activity.searchingWeb"}<<<END_AGENT_ACTIVITY>>>';
    const result = await runSearch([
      'Before. ',
      marker.slice(0, 12),
      marker.slice(12),
      ' After.',
    ]);

    expect(result.text).toBe('Before.  After.');
    expect(result.text).not.toContain('<<<');
  });
});
