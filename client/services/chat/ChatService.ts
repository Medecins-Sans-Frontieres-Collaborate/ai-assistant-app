'use client';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import { Tone } from '@/types/tone';

import { apiClient } from '../api';

/**
 * Unified Chat Service
 *
 * Simple client-side service that routes ALL chat requests to the unified
 * /api/chat endpoint. The server pipeline handles all routing decisions.
 *
 * Features supported (through server-side pipeline):
 * - Text conversations
 * - Image conversations (vision models)
 * - File analysis (documents)
 * - Audio/video transcription
 * - Mixed content (files + images)
 * - RAG with knowledge bases
 * - Intelligent search (tool routing)
 * - AI Foundry agents
 * - ANY combination of the above
 *
 * Usage:
 * ```typescript
 * const stream = await chatService.chat(model, messages, {
 *   botId: 'my-bot',        // Enable RAG
 *   searchMode: 'intelligent', // Enable search
 *   temperature: 0.7,
 * });
 * ```
 */
export class ChatService {
  /**
   * Sends a chat request to the unified endpoint.
   *
   * The server pipeline automatically:
   * - Detects content types (files, images, audio)
   * - Processes content (download, extract, transcribe)
   * - Applies features (RAG, search, agents)
   * - Executes with the right model
   * - Returns streaming or non-streaming response
   *
   * @param model - The model to use
   * @param messages - The conversation messages
   * @param options - Optional parameters
   * @returns ReadableStream for processing response chunks
   */
  public async chat(
    model: OpenAIModel,
    messages: Message[],
    options?: {
      prompt?: string;
      temperature?: number;
      stream?: boolean;
      reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
      verbosity?: 'low' | 'medium' | 'high';
      botId?: string;
      threadId?: string;
      searchMode?: SearchMode;
      forcedAgentType?: string;
      isEditorOpen?: boolean;
      tone?: Tone;
    },
  ): Promise<ReadableStream<Uint8Array>> {
    return apiClient.postStream('/api/chat', {
      model,
      messages,
      prompt: options?.prompt,
      temperature: options?.temperature,
      stream: options?.stream ?? true,
      reasoningEffort: options?.reasoningEffort,
      verbosity: options?.verbosity,
      botId: options?.botId,
      threadId: options?.threadId,
      searchMode: options?.searchMode,
      forcedAgentType: options?.forcedAgentType,
      isEditorOpen: options?.isEditorOpen,
      tone: options?.tone,
    });
  }

  /**
   * Sends a non-streaming chat request.
   *
   * @param model - The model to use
   * @param messages - The conversation messages
   * @param options - Optional parameters
   * @returns Complete chat response
   */
  public async chatNonStreaming(
    model: OpenAIModel,
    messages: Message[],
    options?: {
      prompt?: string;
      temperature?: number;
      reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
      verbosity?: 'low' | 'medium' | 'high';
      botId?: string;
      threadId?: string;
      searchMode?: SearchMode;
      forcedAgentType?: string;
      tone?: Tone;
    },
  ): Promise<{ text: string; metadata?: any }> {
    return apiClient.post('/api/chat', {
      model,
      messages,
      prompt: options?.prompt,
      temperature: options?.temperature,
      stream: false,
      reasoningEffort: options?.reasoningEffort,
      verbosity: options?.verbosity,
      botId: options?.botId,
      threadId: options?.threadId,
      searchMode: options?.searchMode,
      forcedAgentType: options?.forcedAgentType,
      tone: options?.tone,
    });
  }
}

// Export singleton instance
export const chatService = new ChatService();
