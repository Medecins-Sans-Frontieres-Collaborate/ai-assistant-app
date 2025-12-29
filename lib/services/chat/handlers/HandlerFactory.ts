import { OpenAIModel } from '@/types/openai';

import { AnthropicHandler } from './AnthropicHandler';
import { AzureOpenAIHandler } from './AzureOpenAIHandler';
import { DeepSeekHandler } from './DeepSeekHandler';
import { ModelHandler } from './ModelHandler';
import { StandardOpenAIHandler } from './StandardOpenAIHandler';

import OpenAI, { AzureOpenAI } from 'openai';

/**
 * Factory for creating the appropriate ModelHandler based on model configuration.
 *
 * Selection logic:
 * 1. If model.sdk === 'anthropic' → AnthropicHandler (Claude models)
 * 2. If model.sdk === 'azure-openai' → AzureOpenAIHandler (GPT-5, o3, GPT-4.1)
 * 3. If model.avoidSystemPrompt === true → DeepSeekHandler (DeepSeek-R1, V3.1)
 * 4. Otherwise → StandardOpenAIHandler (Grok, Llama, future models)
 */
export class HandlerFactory {
  /**
   * Get the appropriate handler for the given model.
   */
  static getHandler(
    model: OpenAIModel | null | undefined,
    azureClient: AzureOpenAI,
    openAIClient: OpenAI,
  ): ModelHandler {
    // Validate model input
    if (!model) {
      throw new Error('Model configuration is required to create handler');
    }

    // Anthropic Claude models
    if (model.sdk === 'anthropic') {
      return new AnthropicHandler();
    }

    // Azure OpenAI models (GPT-5, o3, GPT-4.1 non-agent)
    if (model.sdk === 'azure-openai') {
      return new AzureOpenAIHandler(azureClient);
    }

    // DeepSeek models (special system prompt handling)
    if (model.avoidSystemPrompt === true) {
      return new DeepSeekHandler(openAIClient);
    }

    // Standard OpenAI API models (Grok, Llama, etc.)
    return new StandardOpenAIHandler(openAIClient);
  }

  /**
   * Get a descriptive name for debugging purposes.
   */
  static getHandlerName(model: OpenAIModel | null | undefined): string {
    if (!model) return 'Unknown';
    if (model.sdk === 'anthropic') return 'AnthropicHandler';
    if (model.sdk === 'azure-openai') return 'AzureOpenAIHandler';
    if (model.avoidSystemPrompt === true) return 'DeepSeekHandler';
    return 'StandardOpenAIHandler';
  }
}
