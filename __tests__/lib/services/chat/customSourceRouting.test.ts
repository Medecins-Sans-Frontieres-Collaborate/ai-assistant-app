// Chat-time routing for custom-source (byom) models:
// - credential middleware resolves the model under the user's own ARM OBO
//   token and binds their credential + account endpoint (prod fail-closed),
// - StandardChatService builds a per-request client set, disables the
//   DeploymentNotFound fallback chain, and skips region resolution.
import { NextRequest } from 'next/server';

import { StandardChatService } from '@/lib/services/chat/StandardChatService';
import { HandlerFactory } from '@/lib/services/chat/handlers/HandlerFactory';
import { ModelHandler } from '@/lib/services/chat/handlers/ModelHandler';
import { createCredentialMiddleware } from '@/lib/services/chat/pipeline/Middleware';
import {
  ModelSelector,
  StreamingService,
  ToneService,
} from '@/lib/services/shared';

import { Message } from '@/types/chat';
import { ErrorCode, PipelineError } from '@/types/errors';
import { OpenAIModel } from '@/types/openai';

import type { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { TokenCredential } from '@azure/identity';
import OpenAI, { AzureOpenAI } from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// getAccessTokenForOBO is mocked, so the request is only forwarded, never read.
const mockReq = {} as unknown as NextRequest;

// Hoisted mocks — must be declared before module imports below.

const resolveCustomSourceModel = vi.hoisted(() => vi.fn());
const getArmToken = vi.hoisted(() => vi.fn());
const getFoundryToken = vi.hoisted(() => vi.fn());
const getAccessTokenForOBO = vi.hoisted(() => vi.fn());
const createAppIdentityCredential = vi.hoisted(() => vi.fn());
const getFallbackModel = vi.hoisted(() => vi.fn());
const resolveChatRegion = vi.hoisted(() => vi.fn());
const isAllowedFoundryHost = vi.hoisted(() => vi.fn());
const AnthropicFoundryHandlerMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/models/customModelSources', () => ({
  resolveCustomSourceModel,
}));

// Mocked (default true) so the disallowed_host branch is testable: armPath
// constrains account names such that no crafted input can derive a
// disallowed host organically.
vi.mock('@/lib/utils/shared/foundryHostAllowlist', () => ({
  isAllowedFoundryHost,
}));

vi.mock('@/lib/services/chat/handlers/AnthropicFoundryHandler', () => ({
  AnthropicFoundryHandler: AnthropicFoundryHandlerMock,
}));

vi.mock('@/lib/services/auth/UserTokenProvider', () => ({
  UserTokenProvider: {
    getInstance: () => ({
      getArmToken,
      getFoundryToken,
    }),
  },
}));

vi.mock('@/lib/services/auth/appIdentityCredential', () => ({
  createAppIdentityCredential,
}));

vi.mock('@/lib/services/agents/AgentDiscoveryService', () => ({
  AgentDiscoveryService: {
    getInstance: () => ({
      lookupUserAgentEndpoint: vi.fn(),
      cacheUserAgentEndpoint: vi.fn(),
      listUserAgents: vi.fn(),
    }),
  },
}));

vi.mock('@/lib/services/auth/OfficeResolver', () => ({
  OfficeResolver: {
    getFoundryEndpoint: vi.fn(() => 'https://eu.services.ai.azure.com'),
  },
}));

vi.mock('@/auth', () => ({
  auth: vi.fn(),
  getAccessTokenForOBO,
}));

// ─── StandardChatService dependencies ────────────────────────────────

vi.mock('openai', () => {
  const AzureOpenAIMock = vi.fn();
  const OpenAIMock = vi.fn();
  return { default: OpenAIMock, AzureOpenAI: AzureOpenAIMock };
});

vi.mock('@anthropic-ai/foundry-sdk', () => ({
  AnthropicFoundry: vi.fn(),
}));

vi.mock('@/lib/services/chat/handlers/HandlerFactory');

vi.mock('@/lib/utils/server/chat/chat', () => ({
  getMessagesToSend: vi.fn(),
}));

vi.mock('@/lib/utils/app/stream/streamProcessor', () => ({
  createAzureOpenAIStreamProcessor: vi.fn(),
}));

vi.mock('@/lib/utils/shared/modelRegion', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveChatRegion,
}));

vi.mock('@/config/models', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // Every deployment error counts as DeploymentNotFound here so the tests can
  // assert that byom requests refuse the fallback chain regardless.
  isDeploymentNotFoundError: vi.fn(() => true),
  getFallbackModel,
}));

// Mock Tiktoken initialization (getGlobalTiktoken)
vi.mock('@dqbd/tiktoken/lite/init', () => {
  class MockTiktoken {
    encode = vi.fn().mockReturnValue([1, 2, 3]);
    free = vi.fn();
  }
  return {
    init: vi.fn().mockResolvedValue(undefined),
    Tiktoken: MockTiktoken,
  };
});

vi.mock('@dqbd/tiktoken/encoders/cl100k_base.json', () => ({
  default: { bpe_ranks: {}, special_tokens: {}, pat_str: '' },
}));

// ─────────────────────────────────────────────────────────────────────

const ACCOUNT_PATH =
  '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/my-acct';
const PROJECT_PATH = `${ACCOUNT_PATH}/projects/default`;
const ACCOUNT_ENDPOINT = 'https://my-acct.services.ai.azure.com';
const BYOM_MODEL_ID = 'byom-abc123-my-gpt';

const resolvedModel = {
  id: BYOM_MODEL_ID,
  name: 'my-gpt',
  maxLength: 128000,
  tokenLimit: 128000,
  deploymentName: 'my-gpt',
  sdk: 'azure-openai',
  isCustomSourceModel: true,
  modelSource: ACCOUNT_PATH,
} as OpenAIModel;

function makeByomContext(overrides: Record<string, unknown> = {}) {
  return {
    session: { user: { mail: 'u@msf.org' } },
    user: { mail: 'u@msf.org', region: 'EU' as const },
    // Client-supplied placeholder — must never be served as-is.
    model: { id: BYOM_MODEL_ID, name: 'my-gpt' } as OpenAIModel,
    modelId: BYOM_MODEL_ID,
    modelSourcePath: ACCOUNT_PATH,
    ...overrides,
  };
}

async function expectModelUnavailable(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected middleware to throw');
    },
    (e) => e,
  );
  expect(error).toBeInstanceOf(PipelineError);
  expect((error as PipelineError).code).toBe(ErrorCode.MODEL_UNAVAILABLE);
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccessTokenForOBO.mockResolvedValue('app-access-token');
  getArmToken.mockResolvedValue('arm-obo-token');
  getFoundryToken.mockResolvedValue('foundry-obo-token');
  resolveCustomSourceModel.mockResolvedValue(resolvedModel);
  resolveChatRegion.mockReturnValue(null);
  isAllowedFoundryHost.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createCredentialMiddleware — custom-source (byom) branch', () => {
  it('resolves the model server-side and binds endpoint + user credential', async () => {
    const result = await createCredentialMiddleware(makeByomContext(), mockReq);

    expect(resolveCustomSourceModel).toHaveBeenCalledWith(
      'arm-obo-token',
      BYOM_MODEL_ID,
      ACCOUNT_PATH,
    );
    expect(result.model).toBe(resolvedModel);
    expect(result.modelId).toBe(BYOM_MODEL_ID);
    expect(result.foundryEndpoint).toBe(ACCOUNT_ENDPOINT);

    // The bound credential is the scope-checked Foundry OBO credential.
    const token = await result.userCredential!.getToken(
      'https://cognitiveservices.azure.com/.default',
    );
    expect((token as { token: string }).token).toBe('foundry-obo-token');
  });

  it('derives the account endpoint from a project-scoped source path', async () => {
    const result = await createCredentialMiddleware(
      makeByomContext({ modelSourcePath: PROJECT_PATH }),
      mockReq,
    );

    expect(result.foundryEndpoint).toBe(ACCOUNT_ENDPOINT);
  });

  it('fails closed when a byom id arrives without modelSourcePath (no fall-through to standard routing)', async () => {
    await expectModelUnavailable(
      createCredentialMiddleware(
        makeByomContext({ modelSourcePath: undefined }),
        mockReq,
      ),
    );
    expect(resolveCustomSourceModel).not.toHaveBeenCalled();
  });

  it('fails closed on a missing modelSourcePath in production too', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expectModelUnavailable(
      createCredentialMiddleware(
        makeByomContext({ modelSourcePath: undefined }),
        mockReq,
      ),
    );
    expect(resolveCustomSourceModel).not.toHaveBeenCalled();
  });

  it('throws MODEL_UNAVAILABLE for an invalid source path', async () => {
    await expectModelUnavailable(
      createCredentialMiddleware(
        makeByomContext({ modelSourcePath: '/etc/passwd' }),
        mockReq,
      ),
    );
    expect(resolveCustomSourceModel).not.toHaveBeenCalled();
  });

  it('throws MODEL_UNAVAILABLE when the derived endpoint fails the Foundry host allow-list', async () => {
    isAllowedFoundryHost.mockReturnValue(false);

    await expectModelUnavailable(
      createCredentialMiddleware(makeByomContext(), mockReq),
    );
    expect(isAllowedFoundryHost).toHaveBeenCalledWith(ACCOUNT_ENDPOINT);
    // The user credential must never be bound to a disallowed host.
    expect(getFoundryToken).not.toHaveBeenCalled();
  });

  it('throws MODEL_UNAVAILABLE when resolution returns null (hash/deployment mismatch)', async () => {
    resolveCustomSourceModel.mockResolvedValue(null);

    await expectModelUnavailable(
      createCredentialMiddleware(makeByomContext(), mockReq),
    );
    expect(getFoundryToken).not.toHaveBeenCalled();
  });

  it('throws MODEL_UNAVAILABLE when discovery errors instead of surfacing a 500', async () => {
    resolveCustomSourceModel.mockRejectedValue(new Error('ARM 503'));

    await expectModelUnavailable(
      createCredentialMiddleware(makeByomContext(), mockReq),
    );
  });

  it('fails closed in production when the ARM OBO token cannot be acquired', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    getAccessTokenForOBO.mockResolvedValue(null);

    await expectModelUnavailable(
      createCredentialMiddleware(makeByomContext(), mockReq),
    );
    expect(resolveCustomSourceModel).not.toHaveBeenCalled();
    expect(createAppIdentityCredential).not.toHaveBeenCalled();
  });

  it('fails closed in production when the Foundry OBO token cannot be acquired', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    getFoundryToken.mockRejectedValue(new Error('OBO down'));

    await expectModelUnavailable(
      createCredentialMiddleware(makeByomContext(), mockReq),
    );
  });

  it('falls back to the app identity in dev when OBO is unavailable', async () => {
    const appCredential: TokenCredential = {
      getToken: vi.fn(async () => ({
        token: 'app-arm-token',
        expiresOnTimestamp: Date.now() + 3600_000,
      })),
    };
    getAccessTokenForOBO.mockResolvedValue(null);
    createAppIdentityCredential.mockResolvedValue(appCredential);

    const result = await createCredentialMiddleware(makeByomContext(), mockReq);

    expect(resolveCustomSourceModel).toHaveBeenCalledWith(
      'app-arm-token',
      BYOM_MODEL_ID,
      ACCOUNT_PATH,
    );
    expect(result.model).toBe(resolvedModel);
    // Without an OBO token the Foundry credential falls back to the same
    // app identity credential.
    expect(result.userCredential).toBe(appCredential);
  });
});

describe('StandardChatService — custom-source (byom) routing', () => {
  let service: StandardChatService;
  let mockModelSelector: ModelSelector;
  let mockToneService: ToneService;
  let mockStreamingService: StreamingService;
  let mockHandler: ModelHandler;

  const defaultAzureClient = { isDefault: true } as unknown as AzureOpenAI;
  const defaultOpenAIClient = { isDefault: true } as unknown as OpenAI;

  const testUser = {
    id: 'user-123',
    mail: 'u@msf.org',
    displayName: 'Test User',
  } as never;

  const messages: Message[] = [
    { role: 'user', content: 'Hello', messageType: undefined },
  ];

  const userCredential: TokenCredential = {
    getToken: vi.fn(async () => ({
      token: 'user-bearer-token',
      expiresOnTimestamp: Date.now() + 3600_000,
    })),
  };

  const customSource = {
    endpoint: ACCOUNT_ENDPOINT,
    credential: userCredential,
  };

  beforeEach(async () => {
    mockModelSelector = {
      selectModel: vi.fn().mockReturnValue({
        modelId: BYOM_MODEL_ID,
        modelConfig: resolvedModel,
      }),
    } as never;
    mockToneService = { applyTone: vi.fn().mockReturnValue('sys') } as never;
    mockStreamingService = {
      getStreamConfig: vi
        .fn()
        .mockReturnValue({ stream: false, temperature: 0.7 }),
    } as never;
    mockHandler = {
      prepareMessages: vi.fn().mockReturnValue([]),
      buildRequestParams: vi.fn().mockReturnValue({}),
      executeRequest: vi.fn().mockResolvedValue({
        choices: [{ message: { content: 'Hi!', role: 'assistant' } }],
      }),
      getModelIdForRequest: vi.fn().mockReturnValue('my-gpt'),
    } as never;

    vi.mocked(HandlerFactory.isAnthropicModel).mockReturnValue(false);
    vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
    vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
      'AzureOpenAIHandler',
    );

    const { getMessagesToSend } = await import('@/lib/utils/server/chat/chat');
    vi.mocked(getMessagesToSend).mockResolvedValue(messages);

    service = new StandardChatService(
      defaultAzureClient,
      defaultOpenAIClient,
      undefined,
      mockModelSelector,
      mockToneService,
      mockStreamingService,
    );
  });

  it('builds per-request clients against the user endpoint + credential', async () => {
    await service.handleChat({
      messages,
      model: resolvedModel,
      user: testUser,
      systemPrompt: 'sys',
      stream: false,
      customSource,
    });

    // Azure OpenAI targets the Cognitive Services alias of the account.
    expect(vi.mocked(AzureOpenAI)).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://my-acct.cognitiveservices.azure.com',
        azureADTokenProvider: expect.any(Function),
      }),
    );
    // OpenAI-compatible gets a bearer minted from the user credential.
    expect(vi.mocked(OpenAI)).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: `${ACCOUNT_ENDPOINT}/openai/v1/`,
        apiKey: 'user-bearer-token',
      }),
    );
    expect(userCredential.getToken).toHaveBeenCalledWith(
      ['https://cognitiveservices.azure.com/.default'],
      expect.anything(),
    );
    // Anthropic client points at the account's /anthropic base.
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk');
    expect(vi.mocked(AnthropicFoundry)).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: `${ACCOUNT_ENDPOINT}/anthropic`,
      }),
    );

    // The handler receives the per-request clients, not the defaults.
    const azureInstance = vi.mocked(AzureOpenAI).mock.instances[0];
    const openAIInstance = vi.mocked(OpenAI).mock.instances[0];
    expect(HandlerFactory.getHandler).toHaveBeenCalledWith(
      resolvedModel,
      azureInstance,
      openAIInstance,
    );
  });

  it('routes anthropic byom models through the per-request AnthropicFoundry client', async () => {
    const anthropicModel = {
      ...resolvedModel,
      id: 'byom-abc123-claude-opus-4-6',
      deploymentName: 'claude-opus-4-6',
      sdk: 'anthropic-foundry',
    } as OpenAIModel;
    vi.mocked(mockModelSelector.selectModel).mockReturnValue({
      modelId: anthropicModel.id,
      modelConfig: anthropicModel,
    } as never);
    vi.mocked(HandlerFactory.isAnthropicModel).mockReturnValue(true);
    AnthropicFoundryHandlerMock.mockImplementation(function () {
      return {
        prepareMessages: vi.fn().mockReturnValue([]),
        buildNonStreamingRequestParams: vi.fn().mockReturnValue({}),
        executeRequest: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Hi!' }],
        }),
        extractTextContent: vi.fn().mockReturnValue('Hi!'),
        extractThinkingContent: vi.fn().mockReturnValue(null),
      };
    });

    // A regional default singleton exists — the byom path must NOT fall back
    // to it (that would reroute the chat through the app's endpoint).
    const defaultAnthropicSingleton = {
      isDefault: true,
    } as unknown as AnthropicFoundry;
    service = new StandardChatService(
      defaultAzureClient,
      defaultOpenAIClient,
      defaultAnthropicSingleton,
      mockModelSelector,
      mockToneService,
      mockStreamingService,
    );

    const response = await service.handleChat({
      messages,
      model: anthropicModel,
      user: testUser,
      systemPrompt: 'sys',
      stream: false,
      customSource,
    });

    expect(response).toBeInstanceOf(Response);
    const { AnthropicFoundry: AnthropicFoundryMock } =
      await import('@anthropic-ai/foundry-sdk');
    const perRequestClient = vi.mocked(AnthropicFoundryMock).mock.instances[0];
    expect(perRequestClient).toBeDefined();
    // The handler executing the chat was built on the per-request client
    // bound to the user's account, not the app's default singleton.
    expect(AnthropicFoundryHandlerMock).toHaveBeenCalledTimes(1);
    expect(AnthropicFoundryHandlerMock.mock.calls[0][0]).toBe(perRequestClient);
    expect(AnthropicFoundryHandlerMock.mock.calls[0][0]).not.toBe(
      defaultAnthropicSingleton,
    );
  });

  it('skips resolveChatRegion for byom requests', async () => {
    await service.handleChat({
      messages,
      model: resolvedModel,
      user: testUser,
      systemPrompt: 'sys',
      stream: false,
      hostedRegion: 'EU',
      customSource,
    });

    expect(resolveChatRegion).not.toHaveBeenCalled();
  });

  it('disables the DeploymentNotFound fallback chain for byom requests', async () => {
    vi.mocked(mockHandler.executeRequest).mockRejectedValue(
      new Error('DeploymentNotFound'),
    );

    await expect(
      service.handleChat({
        messages,
        model: resolvedModel,
        user: testUser,
        systemPrompt: 'sys',
        stream: false,
        customSource,
      }),
    ).rejects.toThrow('DeploymentNotFound');

    expect(getFallbackModel).not.toHaveBeenCalled();
  });

  it('keeps the fallback chain for non-byom requests (control)', async () => {
    vi.mocked(mockHandler.executeRequest).mockRejectedValue(
      new Error('DeploymentNotFound'),
    );
    getFallbackModel.mockReturnValue(null); // chain exhausted → rethrow

    await expect(
      service.handleChat({
        messages,
        model: resolvedModel,
        user: testUser,
        systemPrompt: 'sys',
        stream: false,
      }),
    ).rejects.toThrow('DeploymentNotFound');

    expect(getFallbackModel).toHaveBeenCalled();
    expect(resolveChatRegion).toHaveBeenCalled();
  });
});
