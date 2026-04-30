'use client';

import { trimBodyToByteBudget } from '@/lib/utils/shared/chat/bodyByteBudget';
import { normalizeMessagesForAPI } from '@/lib/utils/shared/chat/messageNormalization';

import { ActiveFile, FileMessageContent, Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import { DisplayNamePreference, StreamingSpeedConfig } from '@/types/settings';
import { Tone } from '@/types/tone';

import { apiClient } from '../api';

/**
 * Converts document translation file URL references into text placeholders.
 * Document translation URLs are historical references that don't need server-side
 * processing - the translation has already been completed.
 *
 * Regular file URLs (/api/file/*) are preserved for server-side processing by
 * FileProcessor, which extracts text, transcribes audio, etc.
 *
 * The original file_url remains in localStorage for UI display purposes.
 *
 * @param messages - Array of messages potentially containing file references
 * @returns Messages with document translation URLs converted to text placeholders
 */
function convertDocumentTranslationUrlsToPlaceholders(
  messages: Message[],
): Message[] {
  return messages.map((message) => {
    // Only process array content (files are in array format)
    if (!Array.isArray(message.content)) {
      return message;
    }

    // Process each content block
    const convertedContent = message.content.map((item) => {
      // Only convert file_url items
      if (item.type !== 'file_url') {
        return item;
      }

      const fileItem = item as FileMessageContent;

      // Only convert document translation URLs - these are historical references
      // Regular /api/file/* URLs should pass through for server-side processing
      if (!fileItem.url.startsWith('/api/document-translation/')) {
        return fileItem;
      }

      // Convert to text placeholder
      const filename = fileItem.originalFilename || 'document';
      const placeholderText = `[Document: ${filename}]`;

      return {
        type: 'text' as const,
        text: placeholderText,
      };
    });

    return {
      ...message,
      content: convertedContent,
    };
  });
}

/**
 * Normalize + transform messages for any `/api/chat` request. Applied in both
 * the streaming and non-streaming paths so the server always sees the same
 * preprocessing pipeline and corruption events are logged the same way.
 */
async function prepareMessagesForAPI(messages: Message[]): Promise<Message[]> {
  // Normalize content shape first — older conversations in localStorage can
  // contain messages whose content is null or a bare TextMessageContent
  // object; those would fail server-side Zod validation with
  // "messages.N.content: Invalid input".
  const { messages: normalizedMessages, report } =
    normalizeMessagesForAPI(messages);
  if (report.repairedCount > 0 || report.droppedCount > 0) {
    console.warn(
      `[ChatService] Normalized conversation history before send: ` +
        `repaired=${report.repairedCount}, dropped=${report.droppedCount}`,
    );
  }

  // Convert document translation URLs to text placeholders. Regular file
  // URLs (/api/file/*) pass through for server-side processing.
  // Image URLs (/api/file/{id}) are also passed through verbatim — the
  // server's ImageReferenceInflator stage walks every message and inflates
  // them to base64 before model handlers run. Sending URLs (not base64)
  // keeps the request body well under the 10 MB cap.
  return convertDocumentTranslationUrlsToPlaceholders(normalizedMessages);
}

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
      signal?: AbortSignal;
      streamingSpeed?: StreamingSpeedConfig;
      includeUserInfoInPrompt?: boolean;
      preferredName?: string;
      userContext?: string;
      displayNamePreference?: DisplayNamePreference;
      customDisplayName?: string;
      activeFiles?: ActiveFile[];
      activeFilesTokensUsed?: number;
      autoInjectPinnedImages?: boolean;
    },
  ): Promise<ReadableStream<Uint8Array>> {
    const messagesWithPlaceholders = await prepareMessagesForAPI(messages);

    const rawBody = {
      model,
      messages: messagesWithPlaceholders,
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
      streamingSpeed: options?.streamingSpeed,
      includeUserInfoInPrompt: options?.includeUserInfoInPrompt,
      preferredName: options?.preferredName,
      userContext: options?.userContext,
      displayNamePreference: options?.displayNamePreference,
      customDisplayName: options?.customDisplayName,
      activeFiles: options?.activeFiles,
      activeFilesTokensUsed: options?.activeFilesTokensUsed,
      autoInjectPinnedImages: options?.autoInjectPinnedImages,
    };

    const { body, report } = trimBodyToByteBudget(rawBody);
    if (report.imagesStripped > 0 || report.messagesDropped > 0) {
      console.warn(
        `[ChatService] Trimmed chat body to fit byte budget: ` +
          `${report.originalBytes} → ${report.finalBytes} bytes ` +
          `(stripped ${report.imagesStripped} image(s), ` +
          `dropped ${report.messagesDropped} message(s)` +
          `${report.exceededBudget ? ', still over budget' : ''})`,
      );
    }

    return apiClient.postStream('/api/chat', body, {
      signal: options?.signal,
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
      includeUserInfoInPrompt?: boolean;
      preferredName?: string;
      userContext?: string;
      displayNamePreference?: DisplayNamePreference;
      customDisplayName?: string;
    },
  ): Promise<{ text: string; metadata?: any }> {
    const messagesWithPlaceholders = await prepareMessagesForAPI(messages);

    const rawBody = {
      model,
      messages: messagesWithPlaceholders,
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
      includeUserInfoInPrompt: options?.includeUserInfoInPrompt,
      preferredName: options?.preferredName,
      userContext: options?.userContext,
      displayNamePreference: options?.displayNamePreference,
      customDisplayName: options?.customDisplayName,
    };

    const { body, report } = trimBodyToByteBudget(rawBody);
    if (report.imagesStripped > 0 || report.messagesDropped > 0) {
      console.warn(
        `[ChatService] Trimmed chat body to fit byte budget: ` +
          `${report.originalBytes} → ${report.finalBytes} bytes ` +
          `(stripped ${report.imagesStripped} image(s), ` +
          `dropped ${report.messagesDropped} message(s)` +
          `${report.exceededBudget ? ', still over budget' : ''})`,
      );
    }

    return apiClient.post('/api/chat', body);
  }
}

// Export singleton instance
export const chatService = new ChatService();
