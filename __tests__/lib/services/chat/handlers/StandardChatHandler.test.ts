import { StandardChatService } from '@/lib/services/chat/StandardChatService';
import { StandardChatHandler } from '@/lib/services/chat/handlers/StandardChatHandler';
import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';

import { Message, MessageType } from '@/types/chat';
import { ErrorCode, PipelineError } from '@/types/errors';

import { createTestChatContext } from '../testUtils';

import { describe, expect, it, vi } from 'vitest';

// Passthrough spy on the M365 executor factory: the mail-screen override
// threading test asserts the payload field reaches the executor OPTIONS,
// which the real factory keeps private.
const createM365ToolExecutorSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/m365/tools/executor', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/m365/tools/executor')>();
  createM365ToolExecutorSpy.mockImplementation(actual.createM365ToolExecutor);
  return { ...actual, createM365ToolExecutor: createM365ToolExecutorSpy };
});

// buildFinalMessages/executeStage are private/protected; expose them via a
// narrow cast for unit tests.
type HandlerInternals = {
  buildFinalMessages(context: ChatContext): Message[];
  executeStage(context: ChatContext): Promise<ChatContext>;
};

function createHandler(): HandlerInternals {
  const service = {} as StandardChatService;
  return new StandardChatHandler(service) as unknown as HandlerInternals;
}

describe('StandardChatHandler.buildFinalMessages', () => {
  it('injects fileSummaries into the last message when content is a plain string', () => {
    const handler = createHandler();
    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: 'Summarize this for me',
          messageType: MessageType.TEXT,
        },
      ],
      processedContent: {
        fileSummaries: [
          {
            filename: 'report.xlsx',
            summary: 'Revenue grew 12% YoY',
            originalContent: '',
          },
        ],
      },
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    const content = result[0].content;
    expect(typeof content).toBe('string');
    expect(content as string).toContain('Summarize this for me');
    expect(content as string).toContain('[Document summary: report.xlsx]');
    expect(content as string).toContain('Revenue grew 12% YoY');
  });

  it('composes processedContent on top of enrichedMessages (web search + file summary)', () => {
    const handler = createHandler();

    // Simulate what ToolRouterEnricher does when web search runs:
    // prepend search context to the last user message and store as enrichedMessages.
    const enrichedLastContent =
      'Web Search results:\n\nlatest MSF news...\n\n---\n\nWhat happened?';

    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: 'What happened?',
          messageType: MessageType.TEXT,
        },
      ],
      enrichedMessages: [
        {
          role: 'user',
          content: enrichedLastContent,
          messageType: MessageType.TEXT,
        },
      ],
      processedContent: {
        fileSummaries: [
          {
            filename: 'brief.pdf',
            summary: 'Operational brief text',
            originalContent: '',
          },
        ],
      },
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    const content = result[0].content as string;
    // Search context from enrichedMessages is preserved
    expect(content).toContain('Web Search results');
    expect(content).toContain('latest MSF news');
    // File summary from processedContent is also present
    expect(content).toContain('[Document summary: brief.pdf]');
    expect(content).toContain('Operational brief text');
  });

  it('injects fileSummaries into array-content messages and drops file_url items', () => {
    const handler = createHandler();
    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summarize this for me' },
            {
              type: 'file_url',
              url: 'https://example.com/report.xlsx',
              originalFilename: 'report.xlsx',
            },
          ],
          messageType: MessageType.FILE,
        },
      ],
      processedContent: {
        fileSummaries: [
          {
            filename: 'report.xlsx',
            summary: 'Revenue grew 12% YoY',
            originalContent: '',
          },
        ],
      },
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    const content = result[0].content;
    // Only one text item remains; stripUnsupportedContentTypes collapses to a string
    expect(typeof content).toBe('string');
    expect(content as string).toContain('Summarize this for me');
    expect(content as string).toContain('[Document summary: report.xlsx]');
    expect(content as string).toContain('Revenue grew 12% YoY');
    // file_url must not leak through
    expect(content as string).not.toContain('file_url');
    expect(content as string).not.toContain('https://example.com/report.xlsx');
  });

  it('passes messages through unchanged when neither enrichedMessages nor processedContent has injectable content', () => {
    const handler = createHandler();
    const context = createTestChatContext({
      messages: [
        {
          role: 'user',
          content: 'Hello there',
          messageType: MessageType.TEXT,
        },
      ],
      processedContent: {},
    });

    const result = handler.buildFinalMessages(context);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Hello there');
  });
});

describe('StandardChatHandler — custom-source (byom) glue', () => {
  const BYOM_ENDPOINT = 'https://my-acct.services.ai.azure.com';

  // The seam under test is the REAL executeStage wiring: only the service it
  // hands off to is mocked.
  function createByomSetup() {
    const handleChat = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const handler = new StandardChatHandler({
      handleChat,
    } as unknown as StandardChatService) as unknown as HandlerInternals;
    return { handler, handleChat };
  }

  function byomContext(overrides: Partial<ChatContext> = {}): ChatContext {
    const credential = {
      getToken: vi.fn(),
    } as unknown as ChatContext['userCredential'];
    return {
      ...createTestChatContext({
        model: {
          id: 'byom-abc123-my-gpt',
          name: 'my-gpt',
          isCustomSourceModel: true,
        },
        stream: false,
      }),
      foundryEndpoint: BYOM_ENDPOINT,
      userCredential: credential,
      ...overrides,
    };
  }

  it('passes the middleware-resolved endpoint + credential to the service as customSource', async () => {
    const { handler, handleChat } = createByomSetup();
    const context = byomContext();

    const result = await handler.executeStage(context);

    expect(handleChat).toHaveBeenCalledTimes(1);
    expect(handleChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: context.model,
        customSource: {
          endpoint: BYOM_ENDPOINT,
          credential: context.userCredential,
        },
      }),
    );
    expect(result.response).toBeDefined();
  });

  it('throws MODEL_UNAVAILABLE when a byom model lost its resolved endpoint', async () => {
    const { handler, handleChat } = createByomSetup();

    const promise = handler.executeStage(
      byomContext({ foundryEndpoint: undefined }),
    );

    await expect(promise).rejects.toBeInstanceOf(PipelineError);
    await expect(promise).rejects.toMatchObject({
      code: ErrorCode.MODEL_UNAVAILABLE,
    });
    // Fail closed: the byom request must never reach the app's clients.
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('throws MODEL_UNAVAILABLE when a byom model lost its user credential', async () => {
    const { handler, handleChat } = createByomSetup();

    await expect(
      handler.executeStage(byomContext({ userCredential: undefined })),
    ).rejects.toMatchObject({ code: ErrorCode.MODEL_UNAVAILABLE });
    expect(handleChat).not.toHaveBeenCalled();
  });

  it('never builds customSource for a non-byom model, even with endpoint/credential in context', async () => {
    const { handler, handleChat } = createByomSetup();
    const context = byomContext({
      model: {
        id: 'gpt-5.2-chat',
        name: 'GPT-5.2 Chat',
        maxLength: 128000,
        tokenLimit: 16384,
      },
    });

    await handler.executeStage(context);

    expect(handleChat).toHaveBeenCalledWith(
      expect.objectContaining({ customSource: undefined }),
    );
  });
});

describe('StandardChatHandler — builtin M365 server seam', () => {
  // Same seam as the byom tests: REAL executeStage, mocked service.
  function createM365Setup() {
    const handleChat = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const handler = new StandardChatHandler({
      handleChat,
    } as unknown as StandardChatService) as unknown as HandlerInternals;
    return { handler, handleChat };
  }

  const builtinEntry = {
    id: 'builtin-m365',
    name: 'Microsoft 365',
    builtin: true,
  };

  function m365Context(overrides: Partial<ChatContext> = {}): ChatContext {
    return {
      ...createTestChatContext({ stream: false }),
      mcpServers: [builtinEntry],
      request: {} as ChatContext['request'],
      ...overrides,
    };
  }

  it('builds the synthetic builtin server + executor when session and request are present', async () => {
    const { handler, handleChat } = createM365Setup();

    await handler.executeStage(m365Context());

    expect(handleChat).toHaveBeenCalledTimes(1);
    const request = handleChat.mock.calls[0][0];
    expect(request.mcpServers).toEqual([
      {
        id: 'builtin-m365',
        label: 'Microsoft 365',
        url: '',
        transport: 'streamable-http',
        auth: { style: 'none' },
        trusted: true,
        provenance: 'builtin',
      },
    ]);
    expect(request.builtinExecutor).toBeDefined();
    expect(typeof request.builtinExecutor.listTools).toBe('function');
    expect(typeof request.builtinExecutor.callTool).toBe('function');
  });

  it('skips the builtin server (no throw) when the context has no request', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, handleChat } = createM365Setup();

    await handler.executeStage(m365Context({ request: undefined }));

    const request = handleChat.mock.calls[0][0];
    expect(request.mcpServers).toBeUndefined();
    expect(request.builtinExecutor).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('builtin-m365'));
    warn.mockRestore();
  });

  it('threads payload m365MailScreenOverrides into the executor as screenOverrideIds', async () => {
    const { handler } = createM365Setup();

    await handler.executeStage(
      m365Context({ m365MailScreenOverrides: ['AAMkAGI2-flagged=1'] }),
    );

    expect(createM365ToolExecutorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        screenOverrideIds: ['AAMkAGI2-flagged=1'],
      }),
    );
  });

  it('ignores a builtin entry with an unknown id', async () => {
    const { handler, handleChat } = createM365Setup();

    await handler.executeStage(
      m365Context({
        mcpServers: [{ id: 'builtin-other', name: 'Nope', builtin: true }],
      }),
    );

    const request = handleChat.mock.calls[0][0];
    expect(request.mcpServers).toBeUndefined();
    expect(request.builtinExecutor).toBeUndefined();
  });
});
