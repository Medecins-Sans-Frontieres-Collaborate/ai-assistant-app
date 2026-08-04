import { Session } from 'next-auth';

import { DEFAULT_SYSTEM_PROMPT } from '@/lib/utils/app/const';
import { stripThinking } from '@/lib/utils/app/stream/thinking';

import { ImageMessageContent, Message, TextMessageContent } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';

/**
 * Creates a SHA-256 hash of an email address for use as user_id.
 * Anthropic API requires user_id to be a UUID or hash, not an email.
 *
 * @param email - The email address to hash
 * @returns A hex-encoded SHA-256 hash of the email
 */
function hashUserEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex');
}

/**
 * Handler for Anthropic Claude models via Azure AI Foundry.
 *
 * Key differences from OpenAI handlers:
 * - Uses client.messages.create() instead of chat.completions.create()
 * - System prompt is a separate parameter, not a message role
 * - Different streaming event format (text_delta vs delta.content)
 * - Messages only support 'user' and 'assistant' roles (no 'system')
 */
export class AnthropicFoundryHandler {
  private client: AnthropicFoundry;
  /**
   * Text of in-array system messages captured by the latest prepareMessages
   * call. Enrichers (RAG, M365 agents, file summaries) inject retrieved
   * context as system-role messages; Anthropic only accepts user/assistant
   * roles in `messages`, so this content must ride the `system` parameter —
   * dropping it severs agents from their sources while citations still
   * render. Handler instances are per-request, so this never crosses
   * requests; MCP loop rounds reuse the instance and keep the context.
   */
  private systemContextFromMessages = '';

  constructor(client: AnthropicFoundry) {
    this.client = client;
  }

  /**
   * Get the Anthropic Foundry client.
   */
  getClient(): AnthropicFoundry {
    return this.client;
  }

  /** The system param: base prompt plus captured in-array system content. */
  private composeSystem(systemPrompt: string): string {
    const base = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    return this.systemContextFromMessages
      ? `${base}\n\n${this.systemContextFromMessages}`
      : base;
  }

  /** Flattens a message's content to plain text (text parts only). */
  private flattenToText(content: Message['content']): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === 'text' && 'text' in c)
        .map((c) => (c as TextMessageContent).text)
        .join('\n');
    }
    if (
      content &&
      typeof content === 'object' &&
      'type' in content &&
      content.type === 'text'
    ) {
      return (content as TextMessageContent).text;
    }
    return '';
  }

  /**
   * Convert OpenAI-style messages to Anthropic format.
   * Anthropic uses a separate system parameter and doesn't support 'system'
   * role in messages — in-array system messages (enricher-injected context)
   * are captured here and appended to the system parameter by the
   * buildRequestParams methods.
   *
   * @param messages - Messages in OpenAI format
   * @param modelConfig - Model configuration (unused but kept for consistency with other handlers)
   * @returns Messages in Anthropic format
   */
  prepareMessages(
    messages: Message[],
    modelConfig: OpenAIModel,
  ): Anthropic.MessageParam[] {
    this.systemContextFromMessages = messages
      .filter((msg) => msg.role === 'system')
      .map((msg) => this.flattenToText(msg.content))
      .filter(Boolean)
      .join('\n\n');
    return messages
      .filter((msg) => msg.role !== 'system') // System rides the system param
      .map((msg): Anthropic.MessageParam => {
        // Handle string content
        if (typeof msg.content === 'string') {
          return {
            role: msg.role as 'user' | 'assistant',
            // Assistant history may carry inline <think> blocks (extended
            // thinking is streamed to the client in that format). Anthropic
            // guidance is to NOT send prior-turn thinking back — strip it
            // so the model doesn't see (and bill for) its own old reasoning.
            content:
              msg.role === 'assistant'
                ? stripThinking(msg.content) || msg.content
                : msg.content,
          };
        }

        // Handle array content (text + images)
        if (Array.isArray(msg.content)) {
          const contentBlocks: Anthropic.ContentBlockParam[] = [];

          for (const item of msg.content) {
            if (item.type === 'text' && 'text' in item) {
              contentBlocks.push({
                type: 'text',
                text: (item as TextMessageContent).text,
              });
            } else if (item.type === 'image_url' && 'image_url' in item) {
              // Convert base64 image URL to Anthropic format
              const url = (item as ImageMessageContent).image_url.url;
              if (url.startsWith('data:')) {
                const [header, data] = url.split(',');
                const mediaTypeMatch = header.match(/data:(.+);base64/);
                const mediaType = (mediaTypeMatch?.[1] ||
                  'image/jpeg') as Anthropic.Base64ImageSource['media_type'];
                contentBlocks.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mediaType,
                    data,
                  },
                });
              }
            }
          }

          return {
            role: msg.role as 'user' | 'assistant',
            content: contentBlocks,
          };
        }

        // Handle single TextMessageContent object
        if (
          typeof msg.content === 'object' &&
          'type' in msg.content &&
          msg.content.type === 'text'
        ) {
          return {
            role: msg.role as 'user' | 'assistant',
            content: (msg.content as TextMessageContent).text,
          };
        }

        // Fallback for unexpected content types
        return {
          role: msg.role as 'user' | 'assistant',
          content: String(msg.content),
        };
      });
  }

  /**
   * Build Anthropic request parameters for non-streaming requests.
   *
   * @param modelId - The model ID
   * @param messages - Prepared Anthropic messages
   * @param systemPrompt - System prompt (separate from messages in Anthropic API)
   * @param temperature - Temperature setting
   * @param user - User session info
   * @param modelConfig - Model configuration
   * @returns Anthropic MessageCreateParams for non-streaming
   */
  buildNonStreamingRequestParams(
    modelId: string,
    messages: Anthropic.MessageParam[],
    systemPrompt: string,
    temperature: number,
    user: Session['user'],
    modelConfig: OpenAIModel,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
  ): Anthropic.MessageCreateParamsNonStreaming {
    const modelToUse = this.getModelIdForRequest(modelId, modelConfig);
    const supportsTemperature = modelConfig?.supportsTemperature !== false;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: modelToUse,
      messages,
      system: this.composeSystem(systemPrompt),
      max_tokens: modelConfig.tokenLimit,
      stream: false,
    };

    // Add temperature if supported
    if (supportsTemperature) {
      params.temperature = temperature;
    }

    this.applyExtendedThinking(params, modelConfig, reasoningEffort);

    // Add user metadata if available (hash email for privacy compliance)
    if (user?.mail) {
      params.metadata = {
        user_id: hashUserEmail(user.mail),
      };
    }

    return params;
  }

  /**
   * Reasoning-effort → extended-thinking budget. The app reuses the SAME
   * effort control the GPT reasoning models expose; on Claude it maps to
   * Anthropic's `thinking.budget_tokens`. `minimal` (or unset) keeps
   * thinking off — extended thinking is opt-in per conversation because it
   * adds cost and latency to every turn.
   */
  private static readonly THINKING_BUDGET_TOKENS: Record<
    'low' | 'medium' | 'high',
    number
  > = {
    low: 2048,
    medium: 4096,
    high: 8192,
  };

  private applyExtendedThinking(
    params:
      | Anthropic.MessageCreateParamsNonStreaming
      | Anthropic.MessageCreateParamsStreaming,
    modelConfig: OpenAIModel,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
  ): void {
    if (!modelConfig.supportsExtendedThinking) return;
    if (!reasoningEffort || reasoningEffort === 'minimal') return;

    const budget =
      AnthropicFoundryHandler.THINKING_BUDGET_TOKENS[reasoningEffort];
    params.thinking = { type: 'enabled', budget_tokens: budget };
    // API constraints with thinking enabled: temperature must be 1, and
    // max_tokens must be strictly greater than budget_tokens (the budget
    // counts against it).
    params.temperature = 1;
    params.max_tokens = Math.max(params.max_tokens, budget + 2048);
  }

  /**
   * Build Anthropic request parameters for streaming requests.
   *
   * @param modelId - The model ID
   * @param messages - Prepared Anthropic messages
   * @param systemPrompt - System prompt (separate from messages in Anthropic API)
   * @param temperature - Temperature setting
   * @param user - User session info
   * @param modelConfig - Model configuration
   * @returns Anthropic MessageCreateParams for streaming
   */
  buildStreamingRequestParams(
    modelId: string,
    messages: Anthropic.MessageParam[],
    systemPrompt: string,
    temperature: number,
    user: Session['user'],
    modelConfig: OpenAIModel,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
  ): Anthropic.MessageCreateParamsStreaming {
    const modelToUse = this.getModelIdForRequest(modelId, modelConfig);
    const supportsTemperature = modelConfig?.supportsTemperature !== false;

    const params: Anthropic.MessageCreateParamsStreaming = {
      model: modelToUse,
      messages,
      system: this.composeSystem(systemPrompt),
      max_tokens: modelConfig.tokenLimit,
      stream: true,
    };

    // Add temperature if supported
    if (supportsTemperature) {
      params.temperature = temperature;
    }

    this.applyExtendedThinking(params, modelConfig, reasoningEffort);

    // Add user metadata if available (hash email for privacy compliance)
    if (user?.mail) {
      params.metadata = {
        user_id: hashUserEmail(user.mail),
      };
    }

    return params;
  }

  /**
   * Execute a non-streaming chat completion request.
   *
   * @param requestParams - The request parameters
   * @returns The message response
   */
  async executeRequest(
    requestParams: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    return await this.client.messages.create(requestParams);
  }

  /**
   * Execute a streaming chat completion request.
   *
   * @param requestParams - The request parameters
   * @returns An async iterable of message stream events
   */
  async executeStreamingRequest(
    requestParams: Anthropic.MessageCreateParamsStreaming,
  ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>> {
    const stream = await this.client.messages.create(requestParams);
    return stream as AsyncIterable<Anthropic.RawMessageStreamEvent>;
  }

  /**
   * Get the model ID to use in the API request.
   * Some models use deployment names instead of model IDs.
   *
   * @param modelId - The original model ID
   * @param modelConfig - The model configuration
   * @returns The model ID to use in the request
   */
  getModelIdForRequest(modelId: string, modelConfig: OpenAIModel): string {
    return modelConfig?.deploymentName || modelId;
  }

  /**
   * Extract text content from a non-streaming Anthropic response.
   *
   * @param message - The Anthropic message response
   * @returns The extracted text content
   */
  extractTextContent(message: Anthropic.Message): string {
    return message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }

  /**
   * Extract thinking content from a non-streaming Anthropic response (if extended thinking is enabled).
   *
   * @param message - The Anthropic message response
   * @returns The extracted thinking content, or undefined if not present
   */
  extractThinkingContent(message: Anthropic.Message): string | undefined {
    const thinkingBlocks = message.content.filter(
      (block): block is Anthropic.ThinkingBlock => block.type === 'thinking',
    );

    if (thinkingBlocks.length === 0) {
      return undefined;
    }

    return thinkingBlocks.map((block) => block.thinking).join('\n');
  }
}
