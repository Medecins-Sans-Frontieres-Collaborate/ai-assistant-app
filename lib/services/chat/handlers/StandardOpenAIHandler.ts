import { Session } from 'next-auth';

import { DEFAULT_SYSTEM_PROMPT } from '@/lib/utils/app/const';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { ChatCompletionParams, ModelHandler } from './ModelHandler';

import OpenAI from 'openai';

/**
 * Handler for standard OpenAI API models via Azure AI Foundry.
 * Used for: Grok 3, Grok 4 Fast Reasoning, Llama 4 Maverick, and future models.
 *
 * Features:
 * - Uses standard OpenAI SDK (via Azure AI Foundry endpoint)
 * - Standard system message handling
 * - Supports standard parameters (temperature, top_p, etc.)
 * - Uses deployment names for routing
 */
export class StandardOpenAIHandler extends ModelHandler {
  private client: OpenAI;

  constructor(client: OpenAI) {
    super();
    this.client = client;
  }

  getClient(): OpenAI {
    return this.client;
  }

  prepareMessages(
    messages: Message[],
    systemPrompt: string | undefined,
    modelConfig: OpenAIModel,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    // Standard approach: add system message at the beginning
    return [
      {
        role: 'system',
        content: systemPrompt || DEFAULT_SYSTEM_PROMPT,
      },
      ...(messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[]),
    ];
  }

  buildRequestParams(
    modelId: string,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: number,
    user: Session['user'],
    streamResponse: boolean,
    modelConfig: OpenAIModel,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
    verbosity?: 'low' | 'medium' | 'high',
  ): ChatCompletionParams {
    const supportsTemperature = modelConfig?.supportsTemperature !== false;

    // Use deployment name if specified, otherwise fall back to model ID
    const modelToUse = this.getModelIdForRequest(modelId, modelConfig);

    const params: any = {
      model: modelToUse,
      messages,
      user: JSON.stringify(user),
      stream: streamResponse,
    };

    // Add temperature if supported (most models do)
    if (supportsTemperature) {
      params.temperature = temperature;
    }

    return params as ChatCompletionParams;
  }
}
