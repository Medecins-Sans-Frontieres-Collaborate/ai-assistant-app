import { Session } from 'next-auth';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import OpenAI, { AzureOpenAI } from 'openai';
import { performance } from 'perf_hooks';

/**
 * Type for chat completion request parameters.
 * Allows flexibility while maintaining some structure.
 */
export type ChatCompletionParams =
  | OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
  | OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;

/**
 * Type for chat completion responses.
 */
export type ChatCompletionResponse =
  | OpenAI.Chat.Completions.ChatCompletion
  | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

/**
 * Abstract base class for model-specific chat handlers.
 * Each provider (Azure OpenAI, DeepSeek, etc.) extends this to implement
 * their specific message preparation and parameter handling logic.
 */
export abstract class ModelHandler {
  constructor() {
    // Base class for model-specific handlers
  }

  /**
   * Prepare messages for the API call.
   * Different providers may need different message formats
   * (e.g., DeepSeek merges system prompts into user messages).
   */
  abstract prepareMessages(
    messages: Message[],
    systemPrompt: string | undefined,
    modelConfig: OpenAIModel,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[];

  /**
   * Build request parameters for chat completion.
   * Different providers support different parameters
   * (e.g., temperature, reasoning_effort, verbosity).
   */
  abstract buildRequestParams(
    modelId: string,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    temperature: number,
    user: Session['user'],
    streamResponse: boolean,
    modelConfig: OpenAIModel,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
    verbosity?: 'low' | 'medium' | 'high',
  ): ChatCompletionParams;

  /**
   * Get the appropriate OpenAI client for this handler.
   */
  abstract getClient(): AzureOpenAI | OpenAI;

  /**
   * Execute the chat completion request and return response.
   */
  async executeRequest(
    requestParams: ChatCompletionParams,
    streamResponse: boolean,
  ): Promise<ChatCompletionResponse> {
    const client = this.getClient();
    const perfStart = performance.now();
    const response = await client.chat.completions.create(requestParams);
    console.log(
      `[Perf] ModelHandler.executeRequest (client.chat.completions.create): ${(performance.now() - perfStart).toFixed(1)}ms`,
    );
    return response;
  }

  /**
   * Get the model ID to use in the API request.
   * Some models use deployment names instead of model IDs.
   */
  getModelIdForRequest(modelId: string, modelConfig: OpenAIModel): string {
    return modelConfig?.deploymentName || modelId;
  }
}
