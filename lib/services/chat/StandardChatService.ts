import { Session } from 'next-auth';

import { getAzureMonitorLogger } from '@/lib/services/observability';
import { MetricsService } from '@/lib/services/observability/MetricsService';

import {
  PendingTranscriptionInfo,
  TranscriptMetadata,
} from '@/lib/utils/app/metadata';
import { TokenUsageMetadata } from '@/lib/utils/app/metadata';
import { createAnthropicStreamProcessor } from '@/lib/utils/app/stream/anthropicStreamProcessor';
import {
  UsageContext,
  createAzureOpenAIStreamProcessor,
} from '@/lib/utils/app/stream/streamProcessor';
import { getMessagesToSend } from '@/lib/utils/server/chat/chat';
import {
  perfLog,
  sanitizeForLog,
} from '@/lib/utils/server/log/logSanitization';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktoken/tiktokenCache';
import { estimateCO2Grams } from '@/lib/utils/shared/emissions';
import { resolveChatRegion } from '@/lib/utils/shared/modelRegion';
import { UserRegion } from '@/lib/utils/shared/region';

import { Message } from '@/types/chat';
import { OpenAIModel, getModelSizeClass } from '@/types/openai';
import { Citation } from '@/types/rag';
import { Tone } from '@/types/tone';

import { ModelSelector, StreamingService, ToneService } from '../shared';
import { AnthropicFoundryHandler } from './handlers/AnthropicFoundryHandler';
import { HandlerFactory } from './handlers/HandlerFactory';

import { getFallbackModel, isDeploymentNotFoundError } from '@/config/models';
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
  /** Requested hosting region (cross-region routing); EU users are forced to EU. */
  hostedRegion?: UserRegion;
}

/** Region-pinned clients supplied by the container (all optional — see ServiceContainer). */
export interface RegionClientResolver {
  (region: UserRegion): {
    azureOpenAIClient?: AzureOpenAI;
    openAIClient?: OpenAI;
    anthropicFoundryClient?: AnthropicFoundry;
  };
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
  private getRegionClients: RegionClientResolver | undefined;

  constructor(
    azureOpenAIClient: AzureOpenAI,
    openAIClient: OpenAI,
    anthropicFoundryClient: AnthropicFoundry | undefined,
    modelSelector: ModelSelector,
    toneService: ToneService,
    streamingService: StreamingService,
    getRegionClients?: RegionClientResolver,
  ) {
    this.azureOpenAIClient = azureOpenAIClient;
    this.openAIClient = openAIClient;
    this.anthropicFoundryClient = anthropicFoundryClient;
    this.modelSelector = modelSelector;
    this.toneService = toneService;
    this.streamingService = streamingService;
    this.getRegionClients = getRegionClients;
  }

  /**
   * Picks the client set for this request's resolved region. `null` region
   * (no preference, non-EU user) or a missing region-specific client keeps
   * the injected default — per-SDK graceful fallback, chat never breaks on
   * missing regional configuration.
   */
  private resolveClients(region: UserRegion | null): {
    azureOpenAIClient: AzureOpenAI;
    openAIClient: OpenAI;
    anthropicFoundryClient: AnthropicFoundry | undefined;
  } {
    const regional =
      region && this.getRegionClients ? this.getRegionClients(region) : null;
    return {
      azureOpenAIClient: regional?.azureOpenAIClient ?? this.azureOpenAIClient,
      openAIClient: regional?.openAIClient ?? this.openAIClient,
      anthropicFoundryClient:
        regional?.anthropicFoundryClient ?? this.anthropicFoundryClient,
    };
  }

  /**
   * The authoritative server-side sink for one request's real token usage:
   * computes the emissions estimate and fire-and-forgets the TokenUsage log
   * event + OTel counters. Never throws (a telemetry failure must not break
   * chat) and never delays the response path.
   */
  private recordUsage(
    usage: TokenUsageMetadata,
    servedConfig: OpenAIModel,
    user: Session['user'],
    streamed: boolean,
    botId?: string,
  ): void {
    try {
      const sizeClass = getModelSizeClass(servedConfig);
      const estimate = estimateCO2Grams({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        sizeClass,
        isDedicatedReasoner: servedConfig.modelType === 'reasoning',
        reasoningEffort: usage.reasoningEffort,
        region: usage.region,
      });
      void getAzureMonitorLogger().logTokenUsage({
        user,
        model: usage.modelId,
        region: usage.region,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningEffort: usage.reasoningEffort,
        sizeClass,
        estimatedCO2Grams: estimate.gCO2e,
        estimatedEnergyWh: estimate.energyWh,
        assumptionsVersion: estimate.assumptionsVersion,
        streamed,
        botId,
      });
      MetricsService.recordTokenUsage(
        {
          prompt: usage.promptTokens,
          completion: usage.completionTokens,
          total: usage.totalTokens,
        },
        { user, model: usage.modelId, operation: 'chat', botId },
      );
    } catch (error) {
      console.error(
        '[StandardChatService] Failed to record token usage:',
        error,
      );
    }
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
      modelConfig.tokenLimit,
      request.user,
    );
    perfLog(
      'StandardChatService.prepareMessages',
      perfMsgStart,
      `(${messagesToSend.length} messages)`,
    );
    // Don't free() - encoding is shared across requests

    // Resolve which region's clients to use (cross-region routing). EU users
    // are always forced to EU inside resolveChatRegion, whatever the client
    // sent; null keeps the default clients (pre-cross-region behavior).
    const chatRegion = resolveChatRegion(
      request.user?.region as UserRegion | undefined,
      request.hostedRegion,
    );
    const clients = this.resolveClients(chatRegion);
    if (chatRegion) {
      console.log(
        `[StandardChatService] Routing chat to ${chatRegion} region endpoints`,
      );
    }

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
        clients.anthropicFoundryClient,
        chatRegion,
        request.botId,
      );
    }

    // Select a handler (OpenAI-compatible) and execute. If the model's
    // deployment is missing in the endpoint this request was routed to
    // (DeploymentNotFound — e.g. a region with a half-applied infra change),
    // fall back through the configured chain instead of hard-failing. The
    // fallback chain is OpenAI-compatible only, so the same handler-selection
    // logic applies to each attempt.
    const attemptedModelIds: string[] = [];
    let activeConfig: OpenAIModel = modelConfig;
    let response:
      | OpenAI.Chat.Completions.ChatCompletion
      | AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    for (;;) {
      attemptedModelIds.push(activeConfig.id);

      const handler = HandlerFactory.getHandler(
        activeConfig,
        clients.azureOpenAIClient,
        clients.openAIClient,
      );

      console.log(
        `[StandardChatService] Using ${HandlerFactory.getHandlerName(activeConfig)} for model: ${sanitizeForLog(activeConfig.id)}`,
      );

      // Prepare messages + params using handler-specific logic
      const preparedMessages = handler.prepareMessages(
        messagesToSend,
        enhancedPrompt,
        activeConfig,
      );
      const requestParams = handler.buildRequestParams(
        handler.getModelIdForRequest(activeConfig.id, activeConfig),
        preparedMessages,
        temperature,
        request.user,
        stream,
        activeConfig,
        request.reasoningEffort,
        request.verbosity,
      );

      // Execute request
      const perfExecStart = performance.now();
      try {
        response = await handler.executeRequest(requestParams, stream);
        perfLog('StandardChatService.executeRequest', perfExecStart);
        break;
      } catch (error) {
        if (!isDeploymentNotFoundError(error)) throw error;

        const fallback = getFallbackModel(attemptedModelIds);
        if (!fallback) {
          console.error(
            `[StandardChatService] Deployment for ${sanitizeForLog(activeConfig.id)} not found and fallback chain exhausted; surfacing error.`,
          );
          throw error;
        }
        console.warn(
          `[StandardChatService] Deployment for ${sanitizeForLog(activeConfig.id)} not found in region; falling back to ${sanitizeForLog(fallback.id)}.`,
        );
        activeConfig = fallback;
      }
    }

    // Usage attribution context: MUST reference activeConfig (the model the
    // fallback chain actually served), the resolved region, and the effort
    // that was actually applied.
    const servedConfig = activeConfig;
    const appliedEffort = servedConfig.supportsReasoningEffort
      ? request.reasoningEffort
      : undefined;
    const usageContext: UsageContext = {
      modelId: servedConfig.id,
      region: chatRegion,
      reasoningEffort: appliedEffort,
      onUsage: (usage) =>
        this.recordUsage(
          usage,
          servedConfig,
          request.user,
          true,
          request.botId,
        ),
    };

    // Return appropriate response format
    if (stream) {
      const processedStream = createAzureOpenAIStreamProcessor(
        response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        undefined, // ragService
        undefined, // stopConversationRef
        request.transcript, // transcript metadata
        request.citations, // web search citations
        request.pendingTranscriptions, // async batch transcription jobs
        usageContext,
      );

      perfLog('StandardChatService.handleChat total', perfStart, '(stream)');
      return new Response(processedStream, {
        headers: STREAMING_RESPONSE_HEADERS,
      });
    } else {
      const completion = response as OpenAI.Chat.Completions.ChatCompletion;

      // Non-streaming completions carry usage on the object directly.
      let usage: TokenUsageMetadata | undefined;
      if (completion.usage) {
        usage = {
          promptTokens: completion.usage.prompt_tokens ?? 0,
          completionTokens: completion.usage.completion_tokens ?? 0,
          totalTokens: completion.usage.total_tokens ?? 0,
          modelId: servedConfig.id,
          region: chatRegion,
          reasoningEffort: appliedEffort,
        };
        this.recordUsage(
          usage,
          servedConfig,
          request.user,
          false,
          request.botId,
        );
      }

      perfLog(
        'StandardChatService.handleChat total',
        perfStart,
        '(non-stream)',
      );
      return new Response(
        JSON.stringify({
          text: completion.choices[0]?.message?.content,
          ...(usage ? { usage } : {}),
        }),
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
    anthropicClient?: AnthropicFoundry,
    chatRegion: UserRegion | null = null,
    botId?: string,
  ): Promise<Response> {
    const client = anthropicClient ?? this.anthropicFoundryClient;
    // Validate Anthropic client is configured
    if (!client) {
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

    const handler = new AnthropicFoundryHandler(client);

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

      // Process the stream with Anthropic-specific processor. Claude models
      // don't use the fallback chain, so modelConfig IS the served model;
      // Anthropic has no tunable reasoning_effort parameter here.
      const processedStream = createAnthropicStreamProcessor(
        response,
        undefined, // stopConversationRef
        transcript,
        citations,
        {
          modelId: modelConfig.id,
          region: chatRegion,
          onUsage: (usage) =>
            this.recordUsage(usage, modelConfig, user, true, botId),
        },
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
      const responseData: {
        text: string;
        thinking?: string;
        usage?: TokenUsageMetadata;
      } = {
        text: textContent,
      };
      if (thinkingContent) {
        responseData.thinking = thinkingContent;
      }
      if (message.usage) {
        responseData.usage = {
          promptTokens: message.usage.input_tokens ?? 0,
          completionTokens: message.usage.output_tokens ?? 0,
          totalTokens:
            (message.usage.input_tokens ?? 0) +
            (message.usage.output_tokens ?? 0),
          modelId: modelConfig.id,
          region: chatRegion,
        };
        this.recordUsage(responseData.usage, modelConfig, user, false, botId);
      }

      return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
