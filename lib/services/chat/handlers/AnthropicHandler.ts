import { Session } from 'next-auth';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import {
  ChatCompletionParams,
  ChatCompletionResponse,
  ModelHandler,
} from './ModelHandler';

import { env } from '@/config/environment';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import OpenAI from 'openai';

/**
 * Anthropic message format
 */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Handler for Anthropic Claude models via Azure AI Foundry.
 *
 * Uses the @anthropic-ai/foundry-sdk with Azure AD authentication.
 * Anthropic has a different API structure than OpenAI:
 * - Uses messages.create() instead of chat.completions.create()
 * - System prompt is a separate parameter, not a message
 * - Different response structure
 */
export class AnthropicHandler extends ModelHandler {
  private client: AnthropicFoundry;
  private systemPrompt: string = '';

  constructor() {
    super();

    // Derive Anthropic endpoint from base AI Foundry endpoint (same pattern as OpenAI client)
    const baseEndpoint = env.AZURE_AI_FOUNDRY_ENDPOINT?.replace(
      '/api/projects/default',
      '',
    );
    const endpoint = `${baseEndpoint}/anthropic/`;

    // Use Azure AD authentication
    const tokenProvider = getBearerTokenProvider(
      new DefaultAzureCredential(),
      'https://cognitiveservices.azure.com/.default',
    );

    this.client = new AnthropicFoundry({
      azureADTokenProvider: tokenProvider,
      baseURL: endpoint,
    });
  }

  /**
   * Prepare messages for Anthropic API.
   * Anthropic doesn't use system messages in the messages array - it's a separate param.
   */
  prepareMessages(
    messages: Message[],
    systemPrompt: string | undefined,
    modelConfig: OpenAIModel,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    // Store system prompt for later use in buildRequestParams
    this.systemPrompt = systemPrompt || '';

    // Convert messages to Anthropic format (only user and assistant roles)
    const anthropicMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [];

    for (const msg of messages) {
      // Skip system messages - they'll be handled separately
      if (msg.role === 'system') {
        continue;
      }

      // Only include user and assistant messages
      if (msg.role === 'user' || msg.role === 'assistant') {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .filter((c) => c.type === 'text')
                  .map((c) => (c as any).text || '')
                  .join('\n')
              : '';

        if (content) {
          anthropicMessages.push({
            role: msg.role,
            content,
          });
        }
      }
    }

    return anthropicMessages;
  }

  /**
   * Build request parameters.
   * Note: This returns OpenAI-style params for interface compatibility,
   * but executeRequest will convert them to Anthropic format.
   */
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
    // Store metadata for executeRequest
    // We'll use a custom property to pass Anthropic-specific data
    const params = {
      model: modelConfig.deploymentName || modelId,
      messages,
      temperature,
      stream: streamResponse,
      max_tokens: modelConfig.tokenLimit || 8192,
      // Custom property to pass system prompt and user info
      // This will be read in executeRequest
      metadata: {
        systemPrompt: this.systemPrompt,
        userId: user?.id || 'anonymous',
      },
    } as any;

    return params;
  }

  /**
   * Get client - returns null since we use Anthropic client directly
   */
  getClient(): OpenAI {
    // Return a dummy - we override executeRequest
    return null as any;
  }

  /**
   * Execute Anthropic API request.
   * Overrides base implementation to use Anthropic SDK.
   */
  async executeRequest(
    requestParams: ChatCompletionParams,
    streamResponse: boolean,
  ): Promise<ChatCompletionResponse> {
    const params = requestParams as any;

    // Convert OpenAI message format to Anthropic format
    const anthropicMessages: AnthropicMessage[] = params.messages
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : '',
      }));

    console.log(
      `[AnthropicHandler] Executing request with model: ${params.model}`,
    );
    console.log(
      `[AnthropicHandler] Messages count: ${anthropicMessages.length}`,
    );
    console.log(
      `[AnthropicHandler] System prompt length: ${params.metadata?.systemPrompt?.length || 0}`,
    );

    if (streamResponse) {
      // Return streaming response
      const stream = await this.client.messages.stream({
        model: params.model,
        max_tokens: params.max_tokens || 8192,
        messages: anthropicMessages,
        system: params.metadata?.systemPrompt || undefined,
        temperature: params.temperature,
      });

      // Convert Anthropic stream to OpenAI-compatible async iterable
      return this.convertStreamToOpenAIFormat(stream);
    } else {
      // Non-streaming request
      const response = await this.client.messages.create({
        model: params.model,
        max_tokens: params.max_tokens || 8192,
        messages: anthropicMessages,
        system: params.metadata?.systemPrompt || undefined,
        temperature: params.temperature,
      });

      // Convert Anthropic response to OpenAI format
      return this.convertResponseToOpenAIFormat(response);
    }
  }

  /**
   * Convert Anthropic streaming response to OpenAI-compatible format.
   */
  private async *convertStreamToOpenAIFormat(
    stream: any,
  ): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
    for await (const event of stream) {
      // Handle different event types from Anthropic
      if (event.type === 'content_block_delta') {
        const delta = event.delta as any;
        if (delta?.type === 'text_delta' && delta?.text) {
          yield {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: 'claude',
            choices: [
              {
                index: 0,
                delta: {
                  content: delta.text,
                },
                finish_reason: null,
              },
            ],
          } as OpenAI.Chat.Completions.ChatCompletionChunk;
        }
      } else if (event.type === 'message_stop') {
        // Final chunk with finish_reason
        yield {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'claude',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
        } as OpenAI.Chat.Completions.ChatCompletionChunk;
      }
    }
  }

  /**
   * Convert Anthropic non-streaming response to OpenAI format.
   */
  private convertResponseToOpenAIFormat(
    response: any,
  ): OpenAI.Chat.Completions.ChatCompletion {
    // Extract text content from Anthropic response
    const textContent = response.content
      ?.filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('');

    return {
      id: response.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: response.model || 'claude',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: textContent || '',
          },
          finish_reason:
            response.stop_reason === 'end_turn' ? 'stop' : response.stop_reason,
        },
      ],
      usage: {
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0,
        total_tokens:
          (response.usage?.input_tokens || 0) +
          (response.usage?.output_tokens || 0),
      },
    } as OpenAI.Chat.Completions.ChatCompletion;
  }
}
