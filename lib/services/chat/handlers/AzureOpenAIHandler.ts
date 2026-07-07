import { Session } from 'next-auth';

import { DEFAULT_SYSTEM_PROMPT } from '@/lib/utils/app/const';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { ChatCompletionParams, ModelHandler } from './ModelHandler';

import OpenAI, { AzureOpenAI } from 'openai';

/** Union of all possible message content types */
type MessageContent =
  | TextMessageContent
  | ImageMessageContent
  | FileMessageContent;

/**
 * Content types supported by Azure OpenAI API.
 * Note: 'file_url' is NOT supported - it's a custom type for internal file references.
 */
const AZURE_SUPPORTED_CONTENT_TYPES = [
  'text',
  'image_url',
  'input_audio',
  'refusal',
  'audio',
  'file',
];

/**
 * Handler for Azure OpenAI models (GPT-5, o3, GPT-4.1 non-agent).
 *
 * Features:
 * - Uses Azure OpenAI SDK
 * - Supports reasoning_effort parameter (GPT-5, o3)
 * - Supports verbosity parameter (GPT-5 only)
 * - Smart system prompt handling: merges into user message for reasoning/omni models
 * - Automatically sanitizes unsupported content types (like file_url)
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

  /**
   * Sanitizes messages to remove content types not supported by Azure OpenAI.
   * This is a defensive measure to prevent API errors if upstream processing
   * fails to convert custom content types like 'file_url'.
   *
   * @param messages - The messages to sanitize
   * @returns Messages with only Azure-supported content types
   */
  private sanitizeMessages(messages: Message[]): Message[] {
    return messages.map((message) => {
      // String content is always valid
      if (typeof message.content === 'string') {
        return message;
      }

      // Non-array content, pass through
      if (!Array.isArray(message.content)) {
        return message;
      }

      // Filter out unsupported content types
      const filteredContent = message.content.filter((c: MessageContent) =>
        AZURE_SUPPORTED_CONTENT_TYPES.includes(c.type),
      );

      // If all content was filtered out, add placeholder text
      if (filteredContent.length === 0) {
        return {
          ...message,
          content: '[Content could not be processed]',
        };
      }

      // If only one text item remains, convert to string for simplicity
      if (
        filteredContent.length === 1 &&
        filteredContent[0].type === 'text' &&
        'text' in filteredContent[0]
      ) {
        return {
          ...message,
          content: filteredContent[0].text,
        };
      }

      return {
        ...message,
        content: filteredContent,
      };
    });
  }

  /**
   * Determines if the model should avoid system prompts.
   * OpenAI reasoning and omni models perform better with instructions in user messages.
   *
   * @param modelConfig - The model configuration
   * @returns True if system prompt should be merged into user message
   */
  private shouldAvoidSystemPrompt(modelConfig: OpenAIModel): boolean {
    // Explicit flag takes precedence (for edge cases)
    if (modelConfig.avoidSystemPrompt !== undefined) {
      return modelConfig.avoidSystemPrompt;
    }
    // Reasoning and omni models don't properly process system prompts
    return (
      modelConfig.modelType === 'reasoning' || modelConfig.modelType === 'omni'
    );
  }

  /**
   * Merges system prompt into first user message for models that don't support system prompts.
   * This ensures instructions are followed by reasoning/omni models.
   *
   * @param messages - The sanitized messages
   * @param systemPrompt - The system prompt to merge
   * @returns Messages with system prompt merged into first user message
   */
  private mergeSystemPromptIntoMessages(
    messages: Message[],
    systemPrompt: string,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const firstUserIndex = messages.findIndex((m) => m.role === 'user');

    return messages.map(
      (msg, index): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
        // Only modify the first user message
        if (index !== firstUserIndex || msg.role !== 'user') {
          return { role: msg.role, content: msg.content as any };
        }

        const content = msg.content;

        // Handle string content
        if (typeof content === 'string') {
          return {
            role: msg.role,
            content: `${systemPrompt}\n\n${content}`,
          };
        }

        // Handle array content (multimodal messages)
        if (Array.isArray(content)) {
          const newContent = content.map((item: any) => {
            if (item.type === 'text' && 'text' in item) {
              return { ...item, text: `${systemPrompt}\n\n${item.text}` };
            }
            return { ...item };
          });
          return { role: msg.role, content: newContent as any };
        }

        return { role: msg.role, content: msg.content as any };
      },
    );
  }

  prepareMessages(
    messages: Message[],
    systemPrompt: string | undefined,
    modelConfig: OpenAIModel,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    // Sanitize messages to remove unsupported content types (like file_url)
    const sanitizedMessages = this.sanitizeMessages(messages);
    const effectiveSystemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;

    // Reasoning/omni models: merge system prompt into first user message
    if (this.shouldAvoidSystemPrompt(modelConfig)) {
      return this.mergeSystemPromptIntoMessages(
        sanitizedMessages,
        effectiveSystemPrompt,
      );
    }

    // Standard approach: system message at the beginning
    return [
      {
        role: 'system',
        content: effectiveSystemPrompt,
      },
      ...(sanitizedMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[]),
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
      // Ask the provider to append a terminal usage chunk (empty `choices`,
      // populated `usage`) so real token counts can be captured for
      // tracking + emissions estimation. Non-streaming responses carry
      // `usage` on the completion object without this.
      ...(streamResponse ? { stream_options: { include_usage: true } } : {}),
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
