import { runMcpToolLoop } from '@/lib/services/mcp/McpToolLoopService';
import { clearToolSchemaCache } from '@/lib/services/mcp/toolSchemaCache';

import { ResolvedMcpServer } from '@/config/mcpCatalog';
import type OpenAI from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConnectMcp = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/mcp/McpClientService', () => ({
  connectMcp: mockConnectMcp,
}));

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const githubServer: ResolvedMcpServer = {
  id: 'github',
  label: 'GitHub',
  url: 'https://api.githubcopilot.com/mcp/',
  transport: 'streamable-http',
  auth: { style: 'bearer' },
  trusted: true,
  authToken: 'token',
};

function textChunks(text: string): Chunk[] {
  return [
    {
      id: 'c',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-test',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    },
    {
      id: 'c',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ] as Chunk[];
}

type Params = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

/** A provider error as the OpenAI SDK raises it. */
const apiError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

const TOOL_REASONING_REFUSAL =
  "400 Function tools with reasoning_effort are not supported for this model in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

/**
 * A handler that fails each call with the next queued error, then streams.
 * Each call's params are snapshotted, because the loop reuses the object.
 */
function makeHandler(chunks: Chunk[], failures: Error[] = []) {
  const queue = [...failures];
  const seen: Params[] = [];
  return {
    seen,
    executeRequest: vi.fn(async (params: Params) => {
      seen.push({ ...params });
      const failure = queue.shift();
      if (failure) throw failure;
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
      };
    }),
  };
}

function mockConnection(instructions?: string) {
  return {
    listTools: vi
      .fn()
      .mockResolvedValue([
        { name: 'list_prs', inputSchema: { type: 'object' } },
      ]),
    getInstructions: vi.fn().mockReturnValue(instructions),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function baseOptions(
  handler: ReturnType<typeof makeHandler>,
  servers: ResolvedMcpServer[],
  model: string,
) {
  return {
    handler: handler as never,
    preparedMessages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'list my PRs' },
    ] as Message[],
    buildParams: (messages: Message[]) =>
      ({
        model,
        messages,
        stream: true,
        reasoning_effort: 'medium',
      }) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    servers,
    loopRound: 0,
    userId: 'user-1',
    usage: { modelId: 'gpt-test', region: null as null, onUsage: vi.fn() },
  };
}

/** Runs one turn to completion and returns the streamed text. */
const runTurn = async (
  handler: ReturnType<typeof makeHandler>,
  model: string,
) => (await runMcpToolLoop(baseOptions(handler, [githubServer], model))).text();

describe('runMcpToolLoop when a model refuses tools with reasoning effort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearToolSchemaCache();
    mockConnectMcp.mockResolvedValue(mockConnection());
  });

  it('repeats the request with reasoning off and answers normally', async () => {
    const handler = makeHandler(textChunks('Done.'), [
      apiError(400, TOOL_REASONING_REFUSAL),
    ]);

    const text = await runTurn(handler, 'model-retry');

    expect(text).toContain('Done.');
    expect(handler.seen.map((params) => params.reasoning_effort)).toEqual([
      'medium',
      'none',
    ]);
    expect(handler.seen[1].tools?.length).toBeGreaterThan(0);
  });

  it('goes straight to reasoning off on the next turn for that model', async () => {
    const first = makeHandler(textChunks('One.'), [
      apiError(400, TOOL_REASONING_REFUSAL),
    ]);
    await runTurn(first, 'model-remembered');

    const second = makeHandler(textChunks('Two.'));
    await runTurn(second, 'model-remembered');

    expect(second.seen.map((params) => params.reasoning_effort)).toEqual([
      'none',
    ]);
  });

  it('leaves reasoning effort alone for a model that accepts it', async () => {
    const handler = makeHandler(textChunks('Done.'));

    await runTurn(handler, 'model-accepts');

    expect(handler.seen.map((params) => params.reasoning_effort)).toEqual([
      'medium',
    ]);
  });

  it('does not retry any other failure', async () => {
    const handler = makeHandler(textChunks('Done.'), [
      apiError(400, 'Invalid schema for function tools[0]'),
    ]);

    await runTurn(handler, 'model-other-error');

    expect(handler.executeRequest).toHaveBeenCalledTimes(1);
  });

  it('gives up when the model refuses again with reasoning off', async () => {
    const handler = makeHandler(textChunks('Done.'), [
      apiError(400, TOOL_REASONING_REFUSAL),
      apiError(400, TOOL_REASONING_REFUSAL),
    ]);

    const text = await runTurn(handler, 'model-refuses-twice');

    expect(handler.executeRequest).toHaveBeenCalledTimes(2);
    expect(text).not.toContain('Done.');
  });
});
