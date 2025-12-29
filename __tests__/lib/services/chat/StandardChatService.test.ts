import { StandardChatService } from '@/lib/services/chat/StandardChatService';
import { HandlerFactory } from '@/lib/services/chat/handlers/HandlerFactory';
import { ModelHandler } from '@/lib/services/chat/handlers/ModelHandler';
import {
  ModelSelector,
  StreamingService,
  ToneService,
} from '@/lib/services/shared';

import { Message } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import OpenAI, { AzureOpenAI } from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('@/lib/utils/server/chat', () => ({
  getMessagesToSend: vi.fn(),
}));

vi.mock('@/lib/utils/app/stream/streamProcessor', () => ({
  createAzureOpenAIStreamProcessor: vi.fn(),
}));

vi.mock('@/lib/services/chat/handlers/HandlerFactory');

vi.mock('fs');

// Mock Tiktoken initialization
vi.mock('@dqbd/tiktoken/lite/init', () => {
  class MockTiktoken {
    encode = vi.fn().mockReturnValue([1, 2, 3, 4, 5]);
    free = vi.fn();
  }

  return {
    init: vi.fn().mockResolvedValue(undefined),
    Tiktoken: MockTiktoken,
  };
});

// Mock tiktoken model
vi.mock('@dqbd/tiktoken/encoders/cl100k_base.json', () => ({
  default: {
    bpe_ranks: {},
    special_tokens: {},
    pat_str: '',
  },
}));

describe('StandardChatService', () => {
  let service: StandardChatService;
  let mockAzureClient: AzureOpenAI;
  let mockOpenAIClient: OpenAI;
  let mockModelSelector: ModelSelector;
  let mockToneService: ToneService;
  let mockStreamingService: StreamingService;
  let mockHandler: ModelHandler;

  const testUser = {
    id: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    displayName: 'Test User',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock clients
    mockAzureClient = {} as AzureOpenAI;
    mockOpenAIClient = {} as OpenAI;

    // Create mock services with vi.fn() for methods we need to spy on
    mockModelSelector = {
      selectModel: vi.fn(),
      isValidModel: vi.fn(),
      isCustomAgent: vi.fn(),
      supportsVision: vi.fn(),
    } as any;

    mockToneService = {
      applyTone: vi.fn(),
      getUserTones: vi.fn(),
    } as any;

    mockStreamingService = {
      shouldStream: vi.fn(),
      getTemperature: vi.fn(),
      isReasoningModel: vi.fn(),
      getStreamConfig: vi.fn(),
    } as any;

    // Create mock handler
    mockHandler = {
      prepareMessages: vi.fn(),
      buildRequestParams: vi.fn(),
      executeRequest: vi.fn(),
      getModelIdForRequest: vi.fn(),
      getClient: vi.fn(),
    } as any;

    // Create service instance
    service = new StandardChatService(
      mockAzureClient,
      mockOpenAIClient,
      mockModelSelector,
      mockToneService,
      mockStreamingService,
    );
  });

  describe('handleChat', () => {
    it('should handle standard chat request successfully (non-streaming)', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      const systemPrompt = 'You are a helpful assistant.';

      // Mock model selector
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'gpt-5',
        modelConfig: model,
      });

      // Mock tone service
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);

      // Mock streaming service
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: false,
        temperature: 0.7,
      });

      // Mock getMessagesToSend
      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      // Mock handler factory
      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );

      // Mock handler methods
      const preparedMessages = [
        { role: 'system', content: systemPrompt, messageType: undefined },
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      vi.mocked(mockHandler.prepareMessages).mockReturnValue(
        preparedMessages as any,
      );
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('gpt-5');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({
        model: 'gpt-5',
        messages: preparedMessages,
        temperature: 0.7,
        stream: false,
      } as any);

      // Mock completion response
      const mockCompletion = {
        choices: [
          {
            message: {
              content: 'Hello! How can I help you?',
              role: 'assistant',
            },
          },
        ],
      };
      vi.mocked(mockHandler.executeRequest).mockResolvedValue(
        mockCompletion as any,
      );

      // Execute
      const response = await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
        temperature: 0.7,
        stream: false,
      });

      // Verify service calls
      expect(mockModelSelector.selectModel).toHaveBeenCalledWith(
        model,
        messages,
      );
      expect(mockToneService.applyTone).toHaveBeenCalledWith(
        undefined, // tone object (not provided in this test)
        systemPrompt,
      );
      expect(mockStreamingService.getStreamConfig).toHaveBeenCalledWith(
        'gpt-5',
        false,
        0.7,
        model,
      );

      // Verify handler calls
      expect(HandlerFactory.getHandler).toHaveBeenCalledWith(
        model,
        mockAzureClient,
        mockOpenAIClient,
      );
      expect(mockHandler.prepareMessages).toHaveBeenCalled();
      expect(mockHandler.buildRequestParams).toHaveBeenCalled();
      expect(mockHandler.executeRequest).toHaveBeenCalled();

      // Verify response
      expect(response).toBeInstanceOf(Response);
      const responseData = await response.json();
      expect(responseData.text).toBe('Hello! How can I help you?');
    });

    it('should handle streaming chat request successfully', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      const systemPrompt = 'You are a helpful assistant.';

      // Mock model selector
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'gpt-5',
        modelConfig: model,
      });

      // Mock tone service
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);

      // Mock streaming service
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: true,
        temperature: 0.7,
      });

      // Mock getMessagesToSend
      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      // Mock handler factory
      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );

      // Mock handler methods
      const preparedMessages = [
        { role: 'system', content: systemPrompt, messageType: undefined },
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      vi.mocked(mockHandler.prepareMessages).mockReturnValue(
        preparedMessages as any,
      );
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('gpt-5');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({
        model: 'gpt-5',
        messages: preparedMessages,
        temperature: 0.7,
        stream: true,
      } as any);

      // Mock streaming response
      const mockStream = (async function* () {
        yield { choices: [{ delta: { content: 'Hello' } }] };
        yield { choices: [{ delta: { content: '!' } }] };
      })();
      vi.mocked(mockHandler.executeRequest).mockResolvedValue(
        mockStream as any,
      );

      // Mock stream processor
      const { createAzureOpenAIStreamProcessor } = await import(
        '@/lib/utils/app/stream/streamProcessor'
      );
      const mockProcessedStream = new ReadableStream();
      vi.mocked(createAzureOpenAIStreamProcessor).mockReturnValue(
        mockProcessedStream,
      );

      // Execute
      const response = await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
        temperature: 0.7,
        stream: true,
      });

      // Verify response
      expect(response).toBeInstanceOf(Response);
      expect(response.headers.get('Content-Type')).toBe(
        'text/plain; charset=utf-8',
      );
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(createAzureOpenAIStreamProcessor).toHaveBeenCalledWith(
        mockStream,
        undefined, // ragService
        undefined, // stopConversationRef
        undefined, // transcript (not provided in this test)
        undefined, // citations (not provided in this test)
      );
    });

    it('should apply tone when tone is specified', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Hello',
          messageType: undefined,
        },
      ];
      const systemPrompt = 'You are a helpful assistant.';
      const enhancedPrompt = `${systemPrompt}\n\n# Writing Style\nUse formal language.`;
      const tone = {
        id: 'professional',
        name: 'Professional',
        description: 'Formal and professional tone',
        voiceRules: 'Use formal language.',
        createdAt: new Date().toISOString(),
        folderId: null,
      };

      // Mock model selector
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'gpt-5',
        modelConfig: model,
      });

      // Mock tone service to return enhanced prompt
      vi.mocked(mockToneService.applyTone).mockReturnValue(enhancedPrompt);

      // Mock streaming service
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: false,
        temperature: 0.7,
      });

      // Mock getMessagesToSend
      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      // Mock handler
      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );
      vi.mocked(mockHandler.prepareMessages).mockReturnValue([
        { role: 'system', content: enhancedPrompt, messageType: undefined },
        { role: 'user', content: 'Hello', messageType: undefined },
      ] as any);
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('gpt-5');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({} as any);
      vi.mocked(mockHandler.executeRequest).mockResolvedValue({
        choices: [{ message: { content: 'Response', role: 'assistant' } }],
      } as any);

      // Execute
      await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
        temperature: 0.7,
        stream: false,
        tone,
      });

      // Verify tone service was called
      expect(mockToneService.applyTone).toHaveBeenCalledWith(
        tone,
        systemPrompt,
      );

      // Verify enhanced prompt was used
      expect(mockHandler.prepareMessages).toHaveBeenCalledWith(
        messages,
        enhancedPrompt,
        model,
      );
    });

    it('should handle reasoning model with reasoningEffort parameter', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_o3];
      const messages: Message[] = [
        { role: 'user', content: 'Solve this problem', messageType: undefined },
      ];
      const systemPrompt = 'You are a helpful assistant.';

      // Mock model selector
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'o3',
        modelConfig: model,
      });

      // Mock tone service
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);

      // Mock streaming service (reasoning models don't stream)
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: false,
        temperature: 1,
      });

      // Mock getMessagesToSend
      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      // Mock handler
      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );
      vi.mocked(mockHandler.prepareMessages).mockReturnValue([
        { role: 'system', content: systemPrompt, messageType: undefined },
        { role: 'user', content: 'Solve this problem', messageType: undefined },
      ] as any);
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('o3');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({
        model: 'o3',
        reasoning_effort: 'high',
      } as any);
      vi.mocked(mockHandler.executeRequest).mockResolvedValue({
        choices: [{ message: { content: 'Solution', role: 'assistant' } }],
      } as any);

      // Execute
      await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
        reasoningEffort: 'high',
        stream: false,
      });

      // Verify buildRequestParams received reasoningEffort
      expect(mockHandler.buildRequestParams).toHaveBeenCalledWith(
        'o3',
        expect.any(Array),
        1,
        testUser,
        false,
        model,
        'high',
        undefined,
      );
    });

    it('should handle errors and log them appropriately', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      const systemPrompt = 'You are a helpful assistant.';
      const error = new Error('API request failed');

      // Mock model selector
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'gpt-5',
        modelConfig: model,
      });

      // Mock tone service
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);

      // Mock streaming service
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: false,
        temperature: 0.7,
      });

      // Mock getMessagesToSend
      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      // Mock handler to throw error
      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );
      vi.mocked(mockHandler.prepareMessages).mockReturnValue([
        { role: 'system', content: systemPrompt, messageType: undefined },
        { role: 'user', content: 'Hello', messageType: undefined },
      ] as any);
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('gpt-5');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({} as any);
      vi.mocked(mockHandler.executeRequest).mockRejectedValue(error);

      // Execute and expect error
      await expect(
        service.handleChat({
          messages,
          model,
          user: testUser,
          systemPrompt,
          temperature: 0.7,
          stream: false,
        }),
      ).rejects.toThrow('API request failed');
    });

    it('should use default stream value of true when not specified', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      const systemPrompt = 'You are a helpful assistant.';

      // Mock model selector
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'gpt-5',
        modelConfig: model,
      });

      // Mock tone service
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);

      // Mock streaming service
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: true,
        temperature: 0.7,
      });

      // Mock getMessagesToSend
      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      // Mock handler
      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );
      vi.mocked(mockHandler.prepareMessages).mockReturnValue([
        { role: 'system', content: systemPrompt, messageType: undefined },
        { role: 'user', content: 'Hello', messageType: undefined },
      ] as any);
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('gpt-5');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({} as any);

      const mockStream = (async function* () {
        yield { choices: [{ delta: { content: 'Hello' } }] };
      })();
      vi.mocked(mockHandler.executeRequest).mockResolvedValue(
        mockStream as any,
      );

      const { createAzureOpenAIStreamProcessor } = await import(
        '@/lib/utils/app/stream/streamProcessor'
      );
      vi.mocked(createAzureOpenAIStreamProcessor).mockReturnValue(
        new ReadableStream(),
      );

      // Execute (without specifying stream)
      await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
      });

      // Verify getStreamConfig was called with true (default)
      expect(mockStreamingService.getStreamConfig).toHaveBeenCalledWith(
        'gpt-5',
        true,
        undefined,
        model,
      );
    });

    it('should pass botId to logger when provided', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      const systemPrompt = 'You are a helpful assistant.';
      const botId = 'bot-123';

      // Mock all dependencies
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'gpt-5',
        modelConfig: model,
      });
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: false,
        temperature: 0.7,
      });

      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );
      vi.mocked(mockHandler.prepareMessages).mockReturnValue([
        { role: 'system', content: systemPrompt, messageType: undefined },
        { role: 'user', content: 'Hello', messageType: undefined },
      ] as any);
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('gpt-5');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({} as any);
      vi.mocked(mockHandler.executeRequest).mockResolvedValue({
        choices: [{ message: { content: 'Response', role: 'assistant' } }],
      } as any);

      // Execute with botId
      await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
        botId,
      });
    });
  });

  describe('integration scenarios', () => {
    it('should handle Azure OpenAI model (gpt-5) complete workflow', async () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        {
          role: 'user',
          content: 'What is TypeScript?',
          messageType: undefined,
        },
      ];
      const systemPrompt = 'You are a programming expert.';

      // Setup mocks
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'gpt-5',
        modelConfig: model,
      });
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: false,
        temperature: 0.7,
      });

      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'AzureOpenAIHandler',
      );
      vi.mocked(mockHandler.prepareMessages).mockReturnValue([
        { role: 'system', content: systemPrompt, messageType: undefined },
        {
          role: 'user',
          content: 'What is TypeScript?',
          messageType: undefined,
        },
      ] as any);
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue('gpt-5');
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({} as any);
      vi.mocked(mockHandler.executeRequest).mockResolvedValue({
        choices: [
          { message: { content: 'TypeScript is...', role: 'assistant' } },
        ],
      } as any);

      // Execute
      const response = await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
      });

      // Verify complete workflow
      expect(mockModelSelector.selectModel).toHaveBeenCalled();
      expect(mockToneService.applyTone).toHaveBeenCalled();
      expect(mockStreamingService.getStreamConfig).toHaveBeenCalled();
      expect(HandlerFactory.getHandler).toHaveBeenCalledWith(
        model,
        mockAzureClient,
        mockOpenAIClient,
      );
      expect(response).toBeInstanceOf(Response);
    });

    it('should handle third-party model (Llama) workflow', async () => {
      const model = OpenAIModels[OpenAIModelID.LLAMA_4_MAVERICK];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
      ];
      const systemPrompt = 'You are helpful.';

      // Setup mocks
      vi.mocked(mockModelSelector.selectModel).mockReturnValue({
        modelId: 'Llama-4-Maverick-17B-128E-Instruct-FP8',
        modelConfig: model,
      });
      vi.mocked(mockToneService.applyTone).mockReturnValue(systemPrompt);
      vi.mocked(mockStreamingService.getStreamConfig).mockReturnValue({
        stream: false,
        temperature: 0.7,
      });

      const { getMessagesToSend } = await import('@/lib/utils/server/chat');
      vi.mocked(getMessagesToSend).mockResolvedValue(messages);

      vi.mocked(HandlerFactory.getHandler).mockReturnValue(mockHandler);
      vi.mocked(HandlerFactory.getHandlerName).mockReturnValue(
        'StandardOpenAIHandler',
      );
      vi.mocked(mockHandler.prepareMessages).mockReturnValue([
        { role: 'system', content: systemPrompt, messageType: undefined },
        { role: 'user', content: 'Hello', messageType: undefined },
      ] as any);
      vi.mocked(mockHandler.getModelIdForRequest).mockReturnValue(
        'Llama-4-Maverick-17B-128E-Instruct-FP8',
      );
      vi.mocked(mockHandler.buildRequestParams).mockReturnValue({} as any);
      vi.mocked(mockHandler.executeRequest).mockResolvedValue({
        choices: [{ message: { content: 'Hi!', role: 'assistant' } }],
      } as any);

      // Execute
      await service.handleChat({
        messages,
        model,
        user: testUser,
        systemPrompt,
      });

      // Verify StandardOpenAIHandler was used
      expect(HandlerFactory.getHandlerName).toHaveBeenCalledWith(model);
    });
  });
});
