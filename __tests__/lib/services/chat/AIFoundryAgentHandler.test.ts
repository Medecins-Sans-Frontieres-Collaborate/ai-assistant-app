import { Session } from 'next-auth';

import { AIFoundryAgentHandler } from '@/lib/services/chat/AIFoundryAgentHandler';

import { Message, MessageType } from '@/types/chat';
import { ErrorCode, PipelineError } from '@/types/errors';
import { OpenAIModel } from '@/types/openai';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Keep the handler's heavy/external dependencies inert so we can exercise the
// error-mapping logic deterministically. The Foundry SDK client is the only
// one whose behaviour the individual tests vary.
const responsesCreate = vi.fn();
const conversationsCreate = vi.fn(async () => ({ id: 'conv_123' }));
const conversationsItemsCreate = vi.fn(async () => ({}));

vi.mock('@azure/ai-projects', () => ({
  AIProjectClient: class {
    async getOpenAIClient() {
      return {
        conversations: {
          create: conversationsCreate,
          items: { create: conversationsItemsCreate },
        },
        responses: { create: responsesCreate },
      };
    }
  },
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
}));

vi.mock('@/lib/utils/server/tiktoken/tiktokenCache', () => ({
  getGlobalTiktoken: vi.fn(async () => ({ encode: () => [] })),
}));

vi.mock('@/lib/utils/server/chat/chat', () => ({
  getMessagesToSend: vi.fn(async (messages: Message[]) => messages),
}));

vi.mock('@/lib/services/observability/MetricsService', () => ({
  MetricsService: {
    recordRequest: vi.fn(),
    recordError: vi.fn(),
  },
}));

const ALLOWED_ENDPOINT = 'https://example.services.ai.azure.com';

const user = {
  id: 'user-1',
  mail: 'user@example.org',
} as Session['user'];

const messages: Message[] = [
  { role: 'user', content: 'Hello', messageType: MessageType.TEXT },
];

function baseModel(overrides: Partial<OpenAIModel> = {}): OpenAIModel {
  return {
    id: 'custom-style-guide-bot',
    name: 'Style Guide Bot',
    maxLength: 128000,
    tokenLimit: 16000,
    agentId: 'asst_legacy',
    ...overrides,
  } as OpenAIModel;
}

describe('AIFoundryAgentHandler error mapping', () => {
  let handler: AIFoundryAgentHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new AIFoundryAgentHandler();
  });

  it('maps a missing agentId (stale/legacy agent config) to AGENT_UNAVAILABLE', async () => {
    const model = baseModel({ agentId: undefined });

    await expect(
      handler.handleAgentChat(
        model.id,
        model,
        messages,
        0.5,
        user,
        undefined,
        undefined,
        undefined,
        ALLOWED_ENDPOINT,
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.AGENT_UNAVAILABLE,
    });
  });

  it('maps a Foundry 404 (agent no longer exists) to AGENT_UNAVAILABLE', async () => {
    responsesCreate.mockRejectedValueOnce(
      Object.assign(new Error('Not found'), { statusCode: 404 }),
    );

    const model = baseModel({ agentId: 'asst_legacy' });

    let caught: unknown;
    try {
      await handler.handleAgentChat(
        model.id,
        model,
        messages,
        0.5,
        user,
        undefined,
        undefined,
        undefined,
        ALLOWED_ENDPOINT,
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(PipelineError);
    expect((caught as PipelineError).code).toBe(ErrorCode.AGENT_UNAVAILABLE);
  });
});
