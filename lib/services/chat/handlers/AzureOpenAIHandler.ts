import { Session } from 'next-auth';

import { DEFAULT_SYSTEM_PROMPT } from '@/lib/utils/app/const';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { ChatCompletionParams, ModelHandler } from './ModelHandler';

import OpenAI, { AzureOpenAI } from 'openai';

/**
 * Handler for Azure OpenAI models (GPT-5, o3, GPT-4.1 non-agent).
 *
 * Features:
 * - Uses Azure OpenAI SDK
 * - Supports reasoning_effort parameter (GPT-5, o3)
 * - Supports verbosity parameter (GPT-5 only)
 * - Standard system message handling
 */
export class AzureOpenAIHandler extends ModelHandler {
  private client: AzureOpenAI;

  constructor(client: AzureOpenAI) {
    super();
    this.client = client;
  }

  getClient(): AzureOpenAI {
    return this.client;
  }

  prepareMessages(
    messages: Message[],
    systemPrompt: string | undefined,
    modelConfig: OpenAIModel,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    // Standard approach: system message at the beginning
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

    const params: any = {
      model: modelId,
      messages,
      user: JSON.stringify(user),
      stream: streamResponse,
      max_completion_tokens: modelConfig?.tokenLimit || 16384,
    };

    // Add temperature if supported
    if (supportsTemperature) {
      params.temperature = temperature;
    }

    // Add reasoning_effort if model supports it (GPT-5, o3)
    if (modelConfig?.supportsReasoningEffort && reasoningEffort) {
      params.reasoning_effort = reasoningEffort;
    }

    // Add verbosity if model supports it (GPT-5 models only)
    if (modelConfig?.supportsVerbosity && verbosity) {
      params.verbosity = verbosity;
    }

    return params as ChatCompletionParams;
  }
}
