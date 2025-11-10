import { Session } from 'next-auth';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { ChatCompletionParams, ModelHandler } from './ModelHandler';

import OpenAI from 'openai';

/**
 * Handler for DeepSeek models (DeepSeek-R1, DeepSeek-V3.1).
 *
 * Special Features:
 * - Uses standard OpenAI SDK (via Azure AI Foundry)
 * - **Avoids system prompts** - merges them into first user message instead
 * - DeepSeek models perform better with all instructions in user messages
 * - Supports standard temperature control
 */
export class DeepSeekHandler extends ModelHandler {
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
    // DeepSeek models work better WITHOUT system prompts
    // Merge system prompt into first user message instead

    // Clarify ambiguous instructions for DeepSeek
    // "Respond using markdown" is interpreted too literally by DeepSeek
    let modifiedSystemPrompt = systemPrompt;
    if (systemPrompt) {
      modifiedSystemPrompt = systemPrompt.replace(
        'Respond using markdown.',
        'Use markdown formatting in your responses (headers, lists, bold, code blocks where appropriate).',
      );
    }

    // Deep copy messages to avoid mutation
    const messagesToUse = messages.map(
      (msg, index): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
        // Don't modify messages until we find the first user message
        if (!modifiedSystemPrompt || msg.role !== 'user') {
          return { role: msg.role, content: msg.content as any };
        }

        // Only modify the first user message
        const firstUserIndex = messages.findIndex((m) => m.role === 'user');
        if (index !== firstUserIndex) {
          return { role: msg.role, content: msg.content as any };
        }

        const content = msg.content;

        if (typeof content === 'string') {
          return {
            role: msg.role,
            content: `${modifiedSystemPrompt}\n\n${content}`,
          } as OpenAI.Chat.Completions.ChatCompletionMessageParam;
        } else if (Array.isArray(content)) {
          // Deep copy the content array and modify the text item
          const newContent = content.map((item: any) => {
            if (item.type === 'text' && 'text' in item) {
              return {
                ...item,
                text: `${modifiedSystemPrompt}\n\n${item.text}`,
              };
            }
            return { ...item };
          });
          return {
            role: msg.role,
            content: newContent as any,
          };
        }

        return { role: msg.role, content: msg.content as any };
      },
    );

    return messagesToUse;
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

    // Use deployment name if specified (e.g., "DeepSeek-R1")
    const modelToUse = this.getModelIdForRequest(modelId, modelConfig);

    const params: any = {
      model: modelToUse,
      messages,
      user: JSON.stringify(user),
      stream: streamResponse,
    };

    // DeepSeek models support temperature
    if (supportsTemperature) {
      params.temperature = temperature;
    }

    return params as ChatCompletionParams;
  }
}
