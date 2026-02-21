'use client';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import { FileMessageContent, ImageMessageContent, Message } from '@/types/chat';
import { CodeInterpreterMode } from '@/types/codeInterpreter';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import { DisplayNamePreference, StreamingSpeedConfig } from '@/types/settings';
import { Tone } from '@/types/tone';

import { apiClient } from '../api';

/**
 * Converts image URL references in messages to base64 data URLs.
 * This is necessary because the LLM API cannot access our internal URLs.
 * The conversion happens at API call time, not at storage time, so
 * localStorage keeps the small file references.
 *
 * @param messages - Array of messages potentially containing image references
 * @returns Messages with image URLs converted to base64
 */
async function convertImagesToBase64(messages: Message[]): Promise<Message[]> {
  return Promise.all(
    messages.map(async (message) => {
      // Only process array content (images are in array format)
      if (!Array.isArray(message.content)) {
        return message;
      }

      // Process each content block
      const convertedContent = await Promise.all(
        message.content.map(async (item) => {
          // Only convert image_url items
          if (item.type !== 'image_url') {
            return item;
          }

          const imageItem = item as ImageMessageContent;

          // Already base64 - no conversion needed
          if (imageItem.image_url.url.startsWith('data:')) {
            return imageItem;
          }

          // Fetch base64 from server
          try {
            const base64Url =
              await fetchImageBase64FromMessageContent(imageItem);
            return {
              ...imageItem,
              image_url: {
                ...imageItem.image_url,
                url: base64Url,
              },
            };
          } catch (error) {
            console.error(
              '[ChatService] Failed to convert image to base64:',
              error,
            );
            // Return original on error - server will fail with clear error
            return imageItem;
          }
        }),
      );

      return {
        ...message,
        content: convertedContent,
      };
    }),
  );
}

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
      codeInterpreterMode?: CodeInterpreterMode;
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
    },
  ): Promise<ReadableStream<Uint8Array>> {
    // Convert image file references to base64 at API call time
    // This keeps localStorage small (file refs only) while sending base64 to server
    const messagesWithBase64Images = await convertImagesToBase64(messages);

    // Convert document translation URLs to text placeholders
    // Regular file URLs (/api/file/*) pass through for server-side processing
    const messagesWithPlaceholders =
      convertDocumentTranslationUrlsToPlaceholders(messagesWithBase64Images);

    return apiClient.postStream(
      '/api/chat',
      {
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
        codeInterpreterMode: options?.codeInterpreterMode,
        forcedAgentType: options?.forcedAgentType,
        isEditorOpen: options?.isEditorOpen,
        tone: options?.tone,
        streamingSpeed: options?.streamingSpeed,
        includeUserInfoInPrompt: options?.includeUserInfoInPrompt,
        preferredName: options?.preferredName,
        userContext: options?.userContext,
        displayNamePreference: options?.displayNamePreference,
        customDisplayName: options?.customDisplayName,
      },
      {
        signal: options?.signal,
      },
    );
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
    // Convert image file references to base64 at API call time
    const messagesWithBase64Images = await convertImagesToBase64(messages);

    // Convert document translation URLs to text placeholders
    const messagesWithPlaceholders =
      convertDocumentTranslationUrlsToPlaceholders(messagesWithBase64Images);

    return apiClient.post('/api/chat', {
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
    });
  }
}

// Export singleton instance
export const chatService = new ChatService();
