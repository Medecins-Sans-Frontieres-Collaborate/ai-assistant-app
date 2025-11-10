import { Session } from 'next-auth';

import { TranscriptMetadata } from '@/lib/utils/app/metadata';
import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';
import { getMessagesToSend } from '@/lib/utils/server/chat';
import { sanitizeForLog } from '@/lib/utils/server/logSanitization';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktokenCache';

import { Message } from '@/types/chat';
import { OpenAIModel, OpenAIModelID } from '@/types/openai';
import { Citation } from '@/types/rag';
import { Tone } from '@/types/tone';

import { ModelSelector, StreamingService, ToneService } from '../shared';
import { HandlerFactory } from './handlers/HandlerFactory';

import OpenAI, { AzureOpenAI } from 'openai';

/**
 * Request parameters for standard chat.
 */
export interface StandardChatRequest {
  messages: Message[];
  model: OpenAIModel;
  user: Session['user'];
  systemPrompt: string;
  temperature?: number;
  stream?: boolean;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  verbosity?: 'low' | 'medium' | 'high';
  botId?: string;
  transcript?: TranscriptMetadata;
  citations?: Citation[]; // Web search citations to include in response
  tone?: Tone; // Full tone object from client
}

/**
 * Service responsible for handling standard (non-RAG, non-agent) chat completions.
 *
 * Handles:
 * - Model selection and validation
 * - Tone application
 * - Message preparation with token limits
 * - Provider-specific request execution (Azure OpenAI, DeepSeek, etc.)
 * - Streaming and non-streaming responses
 * - Logging
 *
 * Uses dependency injection for all dependencies.
 */
export class StandardChatService {
  private azureOpenAIClient: AzureOpenAI;
  private openAIClient: OpenAI;
  private modelSelector: ModelSelector;
  private toneService: ToneService;
  private streamingService: StreamingService;

  constructor(
    azureOpenAIClient: AzureOpenAI,
    openAIClient: OpenAI,
    modelSelector: ModelSelector,
    toneService: ToneService,
    streamingService: StreamingService,
  ) {
    this.azureOpenAIClient = azureOpenAIClient;
    this.openAIClient = openAIClient;
    this.modelSelector = modelSelector;
    this.toneService = toneService;
    this.streamingService = streamingService;
  }

  /**
   * Handles a standard chat request.
   *
   * @param request - The chat request parameters
   * @returns Response with streaming or JSON content
   */
  public async handleChat(request: StandardChatRequest): Promise<Response> {
    const startTime = Date.now();

    // Select appropriate model (may upgrade for images, validate, etc.)
    const { modelId, modelConfig } = this.modelSelector.selectModel(
      request.model,
      request.messages,
    );

    // Apply tone to system prompt if specified
    const enhancedPrompt = this.toneService.applyTone(
      request.tone,
      request.systemPrompt,
    );
    if (request.tone) {
      console.log('[StandardChatService] Applied tone:', request.tone.name);
      console.log(
        '[StandardChatService] Enhanced prompt length:',
        enhancedPrompt.length,
        'Original:',
        request.systemPrompt.length,
      );
    }

    // Determine streaming and temperature based on model
    const { stream, temperature } = this.streamingService.getStreamConfig(
      modelId,
      request.stream ?? true,
      request.temperature,
      modelConfig,
    );

    // Prepare messages with token limit filtering
    // Use cached Tiktoken instance for better performance
    const encoding = await getGlobalTiktoken();
    const promptTokens = encoding.encode(enhancedPrompt);
    const messagesToSend = await getMessagesToSend(
      request.messages,
      encoding,
      promptTokens.length,
      modelConfig.tokenLimit,
      request.user,
    );
    // Don't free() - encoding is shared across requests

    // Get appropriate handler for this model
    const handler = HandlerFactory.getHandler(
      modelConfig,
      this.azureOpenAIClient,
      this.openAIClient,
    );

    console.log(
      `[StandardChatService] Using ${HandlerFactory.getHandlerName(modelConfig)} for model: ${sanitizeForLog(modelId)}`,
    );

    // Prepare messages using handler-specific logic
    const preparedMessages = handler.prepareMessages(
      messagesToSend,
      enhancedPrompt,
      modelConfig,
    );

    // Build request parameters
    const requestParams = handler.buildRequestParams(
      handler.getModelIdForRequest(modelId, modelConfig),
      preparedMessages,
      temperature,
      request.user,
      stream,
      modelConfig,
      request.reasoningEffort,
      request.verbosity,
    );

    // Execute request
    const response = await handler.executeRequest(requestParams, stream);

    // Return appropriate response format
    if (stream) {
      const processedStream = createAzureOpenAIStreamProcessor(
        response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        undefined, // ragService
        undefined, // stopConversationRef
        request.transcript, // transcript metadata
        request.citations, // web search citations
      );

      return new Response(processedStream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    } else {
      const completion = response as OpenAI.Chat.Completions.ChatCompletion;

      return new Response(
        JSON.stringify({ text: completion.choices[0]?.message?.content }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
  }
}
