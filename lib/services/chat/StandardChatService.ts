import { Session } from 'next-auth';

import {
  PendingTranscriptionInfo,
  TranscriptMetadata,
} from '@/lib/utils/app/metadata';
import { createAnthropicStreamProcessor } from '@/lib/utils/app/stream/anthropicStreamProcessor';
import { createAzureOpenAIStreamProcessor } from '@/lib/utils/app/stream/streamProcessor';
import { getMessagesToSend } from '@/lib/utils/server/chat/chat';
import {
  perfLog,
  sanitizeForLog,
} from '@/lib/utils/server/log/logSanitization';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktoken/tiktokenCache';

import { Message } from '@/types/chat';
import { ExtractionResponseFormat } from '@/types/extractionRecipe';
import { OpenAIModel } from '@/types/openai';
import { Citation } from '@/types/rag';
import { Tone } from '@/types/tone';

import { ModelSelector, StreamingService, ToneService } from '../shared';
import { AnthropicFoundryHandler } from './handlers/AnthropicFoundryHandler';
import { HandlerFactory } from './handlers/HandlerFactory';

import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import OpenAI, { AzureOpenAI } from 'openai';
import { performance } from 'perf_hooks';

/**
 * Streaming speed configuration for smooth text output.
 */
export interface StreamingSpeedConfig {
  charsPerBatch: number;
  delayMs: number;
}

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
  pendingTranscriptions?: PendingTranscriptionInfo[]; // Async batch transcription jobs
  streamingSpeed?: StreamingSpeedConfig; // Smooth streaming speed configuration
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
  private anthropicFoundryClient: AnthropicFoundry | undefined;
  private modelSelector: ModelSelector;
  private toneService: ToneService;
  private streamingService: StreamingService;

  constructor(
    azureOpenAIClient: AzureOpenAI,
    openAIClient: OpenAI,
    anthropicFoundryClient: AnthropicFoundry | undefined,
    modelSelector: ModelSelector,
    toneService: ToneService,
    streamingService: StreamingService,
  ) {
    this.azureOpenAIClient = azureOpenAIClient;
    this.openAIClient = openAIClient;
    this.anthropicFoundryClient = anthropicFoundryClient;
    this.modelSelector = modelSelector;
    this.toneService = toneService;
    this.streamingService = streamingService;
  }

  /**
   * Handles a structured-data-extraction request. Bypasses the streaming /
   * tone / token-budget machinery in `handleChat` — extraction is always a
   * single non-streaming call (v1 doesn't stream partial JSON) and the
   * system prompt was already composed upstream by `ExtractionEnricher`.
   *
   * Strict mode passes `response_format: { type: 'json_schema', json_schema: { name, strict, schema } }`.
   * Auto mode (no schema, just a propose-your-own-structure prompt) uses
   * `response_format: { type: 'json_object' }` instead.
   *
   * @returns Parsed JSON object emitted by the model (untyped — caller maps
   *          it to `ExtractionDataset[]` using the recipe metadata).
   */
  public async handleExtraction(request: {
    messages: Message[];
    model: OpenAIModel;
    user: Session['user'];
    systemPrompt: string;
    responseFormat: ExtractionResponseFormat;
  }): Promise<{ parsed: Record<string, unknown>; raw: string }> {
    const { modelId, modelConfig } = this.modelSelector.selectModel(
      request.model,
      request.messages,
    );

    console.log(
      `[StandardChatService] Extraction call: model=${sanitizeForLog(modelId)} strict=${request.responseFormat.strict} keys=${Object.keys(
        (
          request.responseFormat.schema as {
            properties?: Record<string, unknown>;
          }
        )?.properties ?? {},
      ).join(',')}`,
    );

    const apiMessages = [
      { role: 'system' as const, content: request.systemPrompt },
      ...request.messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content:
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .filter((c) => c.type === 'text')
                  .map((c) => (c as { text: string }).text)
                  .join('\n\n')
              : '',
      })),
    ];

    const responseFormat = request.responseFormat.strict
      ? ({
          type: 'json_schema',
          json_schema: {
            name: request.responseFormat.name,
            strict: true,
            schema: request.responseFormat.schema,
          },
        } as const)
      : ({ type: 'json_object' } as const);

    const response = await this.openAIClient.chat.completions.create({
      model: modelConfig.id,
      messages: apiMessages,
      response_format: responseFormat,
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(
        '[StandardChatService] Extraction JSON parse failed:',
        err,
        'raw:',
        sanitizeForLog(raw.slice(0, 500)),
      );
      throw new Error('Failed to parse structured extraction output as JSON');
    }

    return { parsed, raw };
  }

  /**
   * Handles a standard chat request.
   *
   * @param request - The chat request parameters
   * @returns Response with streaming or JSON content
   */
  public async handleChat(request: StandardChatRequest): Promise<Response> {
    const startTime = Date.now();
    const perfStart = performance.now();

    // Select appropriate model (may upgrade for images, validate, etc.)
    const perfModelStart = performance.now();
    const { modelId, modelConfig } = this.modelSelector.selectModel(
      request.model,
      request.messages,
    );
    perfLog(
      'StandardChatService.selectModel',
      perfModelStart,
      `→ ${sanitizeForLog(modelId)}`,
    );

    // Apply tone to system prompt if specified
    const perfToneStart = performance.now();
    const enhancedPrompt = this.toneService.applyTone(
      request.tone,
      request.systemPrompt,
    );
    perfLog('StandardChatService.applyTone', perfToneStart);
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
    const perfMsgStart = performance.now();
    const encoding = await getGlobalTiktoken();
    const promptTokens = encoding.encode(enhancedPrompt);
    const messagesToSend = await getMessagesToSend(
      request.messages,
      encoding,
      promptTokens.length,
      modelConfig.maxLength - modelConfig.tokenLimit,
      request.user,
    );
    perfLog(
      'StandardChatService.prepareMessages',
      perfMsgStart,
      `(${messagesToSend.length} messages)`,
    );
    // Don't free() - encoding is shared across requests

    // Check if this is an Anthropic model (different API)
    if (HandlerFactory.isAnthropicModel(modelConfig)) {
      return this.handleAnthropicChat(
        messagesToSend,
        modelConfig,
        enhancedPrompt,
        temperature,
        stream,
        request.user,
        request.transcript,
        request.citations,
      );
    }

    // Get appropriate handler for this model (OpenAI-compatible)
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
    const perfExecStart = performance.now();
    const response = await handler.executeRequest(requestParams, stream);
    perfLog('StandardChatService.executeRequest', perfExecStart);

    // Return appropriate response format
    if (stream) {
      const processedStream = createAzureOpenAIStreamProcessor(
        response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        undefined, // ragService
        undefined, // stopConversationRef
        request.transcript, // transcript metadata
        request.citations, // web search citations
        request.pendingTranscriptions, // async batch transcription jobs
      );

      perfLog('StandardChatService.handleChat total', perfStart, '(stream)');
      return new Response(processedStream, {
        headers: STREAMING_RESPONSE_HEADERS,
      });
    } else {
      const completion = response as OpenAI.Chat.Completions.ChatCompletion;

      perfLog(
        'StandardChatService.handleChat total',
        perfStart,
        '(non-stream)',
      );
      return new Response(
        JSON.stringify({ text: completion.choices[0]?.message?.content }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  /**
   * Handles chat requests for Anthropic Claude models.
   * Uses the Anthropic Messages API which has a different structure than OpenAI.
   */
  private async handleAnthropicChat(
    messages: Message[],
    modelConfig: OpenAIModel,
    systemPrompt: string,
    temperature: number,
    stream: boolean,
    user: Session['user'],
    transcript?: TranscriptMetadata,
    citations?: Citation[],
  ): Promise<Response> {
    // Validate Anthropic client is configured
    if (!this.anthropicFoundryClient) {
      console.error(
        '[StandardChatService] Anthropic client not configured. Set AZURE_AI_FOUNDRY_ANTHROPIC_ENDPOINT.',
      );
      return new Response(
        JSON.stringify({
          error: 'Claude models not configured. Contact administrator.',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const handler = new AnthropicFoundryHandler(this.anthropicFoundryClient);

    console.log(
      `[StandardChatService] Using AnthropicFoundryHandler for model: ${sanitizeForLog(modelConfig.id)}`,
    );

    // Prepare messages for Anthropic format
    const preparedMessages = handler.prepareMessages(messages, modelConfig);

    if (stream) {
      // Build streaming request parameters
      const requestParams = handler.buildStreamingRequestParams(
        modelConfig.id,
        preparedMessages,
        systemPrompt,
        temperature,
        user,
        modelConfig,
      );

      // Execute streaming request
      const response = await handler.executeStreamingRequest(requestParams);

      // Process the stream with Anthropic-specific processor
      const processedStream = createAnthropicStreamProcessor(
        response,
        undefined, // stopConversationRef
        transcript,
        citations,
      );

      return new Response(processedStream, {
        headers: STREAMING_RESPONSE_HEADERS,
      });
    } else {
      // Build non-streaming request parameters
      const requestParams = handler.buildNonStreamingRequestParams(
        modelConfig.id,
        preparedMessages,
        systemPrompt,
        temperature,
        user,
        modelConfig,
      );

      // Execute non-streaming request
      const message = await handler.executeRequest(requestParams);

      // Extract text content from response
      const textContent = handler.extractTextContent(message);
      const thinkingContent = handler.extractThinkingContent(message);

      // Build response with optional thinking metadata
      const responseData: { text: string; thinking?: string } = {
        text: textContent,
      };
      if (thinkingContent) {
        responseData.thinking = thinkingContent;
      }

      return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
