import { AnthropicFoundryHandler } from '@/lib/services/chat/handlers/AnthropicFoundryHandler';

import { Message, MessageType } from '@/types/chat';
import { OpenAIModel, OpenAIModelID } from '@/types/openai';

import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Helper to compute expected hash for email addresses
function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}

// Mock the AnthropicFoundry client
const createMockClient = () => {
  return {
    messages: {
      create: vi.fn(),
    },
  } as unknown as AnthropicFoundry;
};

describe('AnthropicFoundryHandler', () => {
  let handler: AnthropicFoundryHandler;
  let mockClient: AnthropicFoundry;

  const mockModelConfig: OpenAIModel = {
    id: OpenAIModelID.CLAUDE_SONNET_4_6,
    name: 'Claude Sonnet 4.6',
    maxLength: 200000,
    tokenLimit: 64000,
    modelType: 'omni',
    provider: 'anthropic',
    sdk: 'anthropic-foundry',
    supportsTemperature: true,
    deploymentName: 'claude-sonnet-4-6',
  };

  beforeEach(() => {
    mockClient = createMockClient();
    handler = new AnthropicFoundryHandler(mockClient);
  });

  describe('getClient', () => {
    it('should return the Anthropic client', () => {
      expect(handler.getClient()).toBe(mockClient);
    });
  });

  describe('prepareMessages', () => {
    it('should convert simple string content messages', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: MessageType.TEXT },
        {
          role: 'assistant',
          content: 'Hi there!',
          messageType: MessageType.TEXT,
        },
      ];

      const result = handler.prepareMessages(messages, mockModelConfig);

      expect(result).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ]);
    });

    it('should filter out system messages (handled separately in Anthropic API)', () => {
      const messages: Message[] = [
        {
          role: 'system',
          content: 'You are a helpful assistant',
          messageType: MessageType.TEXT,
        },
        { role: 'user', content: 'Hello', messageType: MessageType.TEXT },
      ];

      const result = handler.prepareMessages(messages, mockModelConfig);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toBe('Hello');
    });

    it('should handle TextMessageContent object', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: { type: 'text', text: 'Hello from object' },
          messageType: MessageType.TEXT,
        },
      ];

      const result = handler.prepareMessages(messages, mockModelConfig);

      expect(result).toEqual([{ role: 'user', content: 'Hello from object' }]);
    });

    it('should handle array content with text blocks', () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' },
          ],
          messageType: MessageType.TEXT,
        },
      ];

      const result = handler.prepareMessages(messages, mockModelConfig);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(Array.isArray(result[0].content)).toBe(true);
      expect(result[0].content).toHaveLength(2);
    });

    it('should convert image content to Anthropic format', () => {
      const base64Image = 'SGVsbG8gV29ybGQ='; // "Hello World" in base64
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: 'auto',
              },
            },
          ],
          messageType: MessageType.IMAGE,
        },
      ];

      const result = handler.prepareMessages(messages, mockModelConfig);

      expect(result).toHaveLength(1);
      expect(Array.isArray(result[0].content)).toBe(true);
      const content = result[0].content as Anthropic.ContentBlockParam[];
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
      expect(content[1]).toEqual({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: base64Image,
        },
      });
    });

    it('should handle PNG images correctly', () => {
      const base64Image = 'iVBORw0KGgo='; // Truncated PNG header
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Image}`,
                detail: 'high',
              },
            },
          ],
          messageType: MessageType.IMAGE,
        },
      ];

      const result = handler.prepareMessages(messages, mockModelConfig);
      const content = result[0].content as Anthropic.ContentBlockParam[];
      const imageBlock = content[0] as Anthropic.ImageBlockParam;

      expect(imageBlock.type).toBe('image');
      expect(imageBlock.source.media_type).toBe('image/png');
    });
  });

  describe('buildNonStreamingRequestParams', () => {
    it('should build correct non-streaming request params', () => {
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: 'Hello' },
      ];
      const user = {
        id: 'user123',
        displayName: 'Test User',
        mail: 'test@example.com',
      };

      const result = handler.buildNonStreamingRequestParams(
        'claude-sonnet-4-6',
        messages,
        'You are a helpful assistant.',
        0.7,
        user,
        mockModelConfig,
      );

      expect(result).toMatchObject({
        model: 'claude-sonnet-4-6',
        messages,
        system: 'You are a helpful assistant.',
        max_tokens: 64000,
        temperature: 0.7,
        stream: false,
        metadata: {
          user_id: hashEmail('test@example.com'),
        },
      });
    });

    it('should use deployment name when available', () => {
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = handler.buildNonStreamingRequestParams(
        'claude-sonnet-4-6',
        messages,
        'System prompt',
        0.5,
        { id: 'user123', displayName: 'Test' },
        mockModelConfig,
      );

      expect(result.model).toBe('claude-sonnet-4-6');
    });

    it('should not include temperature when not supported', () => {
      const configWithoutTemp: OpenAIModel = {
        ...mockModelConfig,
        supportsTemperature: false,
      };
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = handler.buildNonStreamingRequestParams(
        'claude-sonnet-4-6',
        messages,
        'System prompt',
        0.7,
        { id: 'user123', displayName: 'Test' },
        configWithoutTemp,
      );

      expect(result.temperature).toBeUndefined();
    });
  });

  describe('buildStreamingRequestParams', () => {
    it('should build correct streaming request params', () => {
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = handler.buildStreamingRequestParams(
        'claude-sonnet-4-6',
        messages,
        'You are helpful.',
        0.8,
        { id: 'user123', displayName: 'Test', mail: 'user@test.com' },
        mockModelConfig,
      );

      expect(result.stream).toBe(true);
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.temperature).toBe(0.8);
      expect(result.metadata?.user_id).toBe(hashEmail('user@test.com'));
    });
  });

  describe('getModelIdForRequest', () => {
    it('should return deployment name when available', () => {
      const result = handler.getModelIdForRequest(
        'claude-sonnet-4-6',
        mockModelConfig,
      );
      expect(result).toBe('claude-sonnet-4-6');
    });

    it('should fall back to model ID when no deployment name', () => {
      const configWithoutDeployment: OpenAIModel = {
        ...mockModelConfig,
        deploymentName: undefined,
      };

      const result = handler.getModelIdForRequest(
        'claude-sonnet-4-6',
        configWithoutDeployment,
      );
      expect(result).toBe('claude-sonnet-4-6');
    });
  });

  describe('extractTextContent', () => {
    it('should extract text from response content blocks', () => {
      const message: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello, ', citations: null },
          { type: 'text', text: 'world!', citations: null },
        ],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };

      const result = handler.extractTextContent(message);
      expect(result).toBe('Hello, world!');
    });

    it('should filter out non-text blocks', () => {
      const message: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Here is my answer', citations: null },
          {
            type: 'tool_use',
            id: 'tool_123',
            name: 'calculator',
            input: { expression: '2+2' },
          },
        ],
        model: 'claude-sonnet-4-6',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };

      const result = handler.extractTextContent(message);
      expect(result).toBe('Here is my answer');
    });
  });

  describe('extractThinkingContent', () => {
    it('should extract thinking content when present', () => {
      const message: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Let me think about this...',
            signature: 'sig_123',
          },
          { type: 'text', text: 'The answer is 42.', citations: null },
        ],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };

      const result = handler.extractThinkingContent(message);
      expect(result).toBe('Let me think about this...');
    });

    it('should return undefined when no thinking content', () => {
      const message: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Just a response', citations: null }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };

      const result = handler.extractThinkingContent(message);
      expect(result).toBeUndefined();
    });
  });

  describe('executeRequest', () => {
    it('should call client.messages.create with params', async () => {
      const mockResponse: Anthropic.Message = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response', citations: null }],
        model: 'claude-sonnet-4-6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      };

      (
        mockClient.messages.create as ReturnType<typeof vi.fn>
      ).mockResolvedValue(mockResponse);

      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        stream: false,
      };

      const result = await handler.executeRequest(params);

      expect(mockClient.messages.create).toHaveBeenCalledWith(params);
      expect(result).toBe(mockResponse);
    });
  });
});
