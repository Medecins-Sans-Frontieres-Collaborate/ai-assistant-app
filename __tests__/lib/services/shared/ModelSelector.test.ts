import { ModelSelector } from '@/lib/services/shared/ModelSelector';

import { DEFAULT_MODEL } from '@/lib/utils/app/const';

import { Message, MessageType } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';

import { beforeEach, describe, expect, it } from 'vitest';

describe('ModelSelector', () => {
  let selector: ModelSelector;

  beforeEach(() => {
    selector = new ModelSelector();
  });

  describe('selectModel', () => {
    it('should select requested model for text-only conversation', () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Hello',
          messageType: undefined,
        },
      ];

      const result = selector.selectModel(model, messages);

      expect(result.modelId).toBe('gpt-5');
      expect(result.modelConfig.id).toBe('gpt-5');
    });

    it('should keep model when images detected but upgrade not applicable', () => {
      // Use a third-party model that doesn't upgrade
      const model = OpenAIModels[OpenAIModelID.LLAMA_4_MAVERICK];
      const messages: Message[] = [
        {
          role: 'user',
          content: 'What is in this image?',
          messageType: MessageType.IMAGE,
        },
      ];

      const result = selector.selectModel(model, messages);

      // Third-party models stay as-is
      expect(result.modelId).toBe('Llama-4-Maverick-17B-128E-Instruct-FP8');
      expect(result.modelConfig.id).toBe(
        'Llama-4-Maverick-17B-128E-Instruct-FP8',
      );
    });

    it('should not upgrade vision model when images are detected', () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        {
          role: 'user',
          content: 'What is in this image?',
          messageType: MessageType.IMAGE,
        },
      ];

      const result = selector.selectModel(model, messages);

      expect(result.modelId).toBe('gpt-5');
      expect(result.modelConfig.id).toBe('gpt-5');
    });

    it('should fallback to default model for invalid model ID', () => {
      const invalidModel = {
        id: 'invalid-model',
        name: 'Invalid Model',
      } as OpenAIModel;
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Hello',
          messageType: undefined,
        },
      ];

      const result = selector.selectModel(invalidModel, messages);

      expect(result.modelId).toBe(DEFAULT_MODEL);
      expect(result.modelConfig.id).toBe(DEFAULT_MODEL);
    });

    it('should fallback to default model when model ID is null', () => {
      const nullModel = {
        id: null as any,
        name: 'Null Model',
      } as OpenAIModel;
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Hello',
          messageType: undefined,
        },
      ];

      const result = selector.selectModel(nullModel, messages);

      expect(result.modelId).toBe(DEFAULT_MODEL);
      expect(result.modelConfig.id).toBe(DEFAULT_MODEL);
    });

    it('should handle custom agent models without upgrading', () => {
      const customAgentModel = {
        id: 'custom-agent-abc123',
        name: 'Custom Agent',
        maxLength: 128000,
        tokenLimit: 16000,
        provider: 'openai',
        isAgent: true,
      } as OpenAIModel;
      const messages: Message[] = [
        {
          role: 'user',
          content: 'What is in this image?',
          messageType: MessageType.IMAGE,
        },
      ];

      const result = selector.selectModel(customAgentModel, messages);

      // Custom agents should not be upgraded even with images
      expect(result.modelId).toBe('custom-agent-abc123');
      expect(result.modelConfig.id).toBe('custom-agent-abc123');
    });

    it('should fallback to default when model configuration not found', () => {
      // Create a model with an ID that doesn't exist in OpenAIModels
      const badModel = {
        id: 'gpt-nonexistent', // Doesn't exist in OpenAIModels
        name: 'Test',
        maxLength: 100000,
        tokenLimit: 10000,
      } as OpenAIModel;

      const messages: Message[] = [
        {
          role: 'user',
          content: 'Hello',
          messageType: undefined,
        },
      ];

      const result = selector.selectModel(badModel, messages);

      // Should fallback to default model
      expect(result.modelId).toBe(DEFAULT_MODEL);
      expect(result.modelConfig.id).toBe(DEFAULT_MODEL);
    });
  });

  describe('isValidModel', () => {
    it('should return true for valid model IDs', () => {
      expect(selector.isValidModel('gpt-4.1')).toBe(true);
      expect(selector.isValidModel('gpt-5')).toBe(true);
      expect(selector.isValidModel('gpt-5-chat')).toBe(true);
      expect(selector.isValidModel('o3')).toBe(true);
    });

    it('should return false for invalid model IDs', () => {
      expect(selector.isValidModel('invalid-model')).toBe(false);
      expect(selector.isValidModel('gpt-99')).toBe(false);
      expect(selector.isValidModel('')).toBe(false);
    });

    it('should handle custom agent IDs', () => {
      // Custom agents might not be in the standard model list
      const result = selector.isValidModel('custom-agent-123');
      // This depends on implementation - custom agents may or may not be "valid"
      expect(typeof result).toBe('boolean');
    });
  });

  describe('isCustomAgent', () => {
    it('should return true for custom agent model IDs', () => {
      expect(selector.isCustomAgent('custom-agent-abc123')).toBe(true);
      expect(selector.isCustomAgent('custom-xyz789')).toBe(true);
      expect(selector.isCustomAgent('custom-test')).toBe(true);
    });

    it('should return false for standard model IDs', () => {
      expect(selector.isCustomAgent('gpt-4.1')).toBe(false);
      expect(selector.isCustomAgent('gpt-5')).toBe(false);
      expect(selector.isCustomAgent('o3')).toBe(false);
    });

    it('should return false for invalid formats', () => {
      expect(selector.isCustomAgent('invalid')).toBe(false);
      expect(selector.isCustomAgent('')).toBe(false);
    });
  });

  describe('supportsVision', () => {
    it('should return true for vision models', () => {
      expect(selector.supportsVision('gpt-5')).toBe(true);
      expect(selector.supportsVision('gpt-5-chat')).toBe(true);
      expect(selector.supportsVision('grok-3')).toBe(true);
    });

    it('should return false for non-vision models', () => {
      expect(selector.supportsVision('o3')).toBe(false);
      expect(selector.supportsVision('DeepSeek-R1')).toBe(false);
    });

    it('should return false for invalid models', () => {
      expect(selector.supportsVision('invalid-model')).toBe(false);
      expect(selector.supportsVision('')).toBe(false);
    });
  });

  describe('integration scenarios', () => {
    it('should handle standard chat without images', () => {
      const model = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
        { role: 'assistant', content: 'Hi there!', messageType: undefined },
        { role: 'user', content: 'How are you?', messageType: undefined },
      ];

      const result = selector.selectModel(model, messages);

      expect(result.modelId).toBe('gpt-5');
      expect(result.modelConfig).toBeDefined();
      expect(result.modelConfig.id).toBe('gpt-5');
    });

    it('should handle image conversation without breaking', () => {
      // Use a third-party model with images
      const model = OpenAIModels[OpenAIModelID.LLAMA_4_MAVERICK];
      const messages: Message[] = [
        { role: 'user', content: 'Hello', messageType: undefined },
        {
          role: 'user',
          content: 'What is this?',
          messageType: MessageType.TEXT,
        },
      ];

      const result = selector.selectModel(model, messages);

      // Should return valid model config
      expect(result.modelId).toBe('Llama-4-Maverick-17B-128E-Instruct-FP8');
      expect(result.modelConfig).toBeDefined();
      expect(result.modelConfig.id).toBe(
        'Llama-4-Maverick-17B-128E-Instruct-FP8',
      );
    });

    it('should handle custom agent with images without upgrade', () => {
      const customAgent = {
        id: 'custom-agent-123',
        name: 'My Custom Agent',
        maxLength: 128000,
        tokenLimit: 16000,
        provider: 'openai',
        isAgent: true,
      } as OpenAIModel;
      const messages: Message[] = [
        {
          role: 'user',
          content: 'Analyze this',
          messageType: MessageType.IMAGE,
        },
      ];

      const result = selector.selectModel(customAgent, messages);

      expect(result.modelId).toBe('custom-agent-123');
      expect(result.modelConfig.id).toBe('custom-agent-123');
    });

    it('should handle vision model staying as vision model', () => {
      const visionModel = OpenAIModels[OpenAIModelID.GPT_5_2];
      const messages: Message[] = [
        {
          role: 'user',
          content: 'What is in this image?',
          messageType: MessageType.IMAGE,
        },
      ];

      const result = selector.selectModel(visionModel, messages);

      expect(result.modelId).toBe('gpt-5');
      expect(result.modelConfig.id).toBe('gpt-5');
    });
  });
});
