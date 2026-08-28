import { Session } from 'next-auth';

import type { M365BuiltinExecutor } from '@/lib/services/m365/tools/executor';
import { runAnthropicMcpToolLoop } from '@/lib/services/mcp/AnthropicMcpToolLoopService';
import { planMcpSteps } from '@/lib/services/mcp/McpPlannerService';
import { runMcpToolLoop } from '@/lib/services/mcp/McpToolLoopService';
import { sanitizeMcpPlan } from '@/lib/services/mcp/mcpPlan';
import { appendMcpSystemContext } from '@/lib/services/mcp/mcpSystemContext';
import { getAzureMonitorLogger } from '@/lib/services/observability';
import {
  ToolCallTelemetry,
  recordTokenUsage,
  recordToolCall,
} from '@/lib/services/observability/tokenUsageRecorder';

import { OPENAI_API_VERSION } from '@/lib/utils/app/const';
import {
  PendingTranscriptionInfo,
  TranscriptMetadata,
} from '@/lib/utils/app/metadata';
import { TokenUsageMetadata } from '@/lib/utils/app/metadata';
import { createAnthropicStreamProcessor } from '@/lib/utils/app/stream/anthropicStreamProcessor';
import { createResponsesStreamProcessor } from '@/lib/utils/app/stream/responsesStreamProcessor';
import {
  UsageContext,
  createAzureOpenAIStreamProcessor,
} from '@/lib/utils/app/stream/streamProcessor';
import { getMessagesToSend } from '@/lib/utils/server/chat/chat';
import { devTrace } from '@/lib/utils/server/debug/devTrace';
import {
  perfLog,
  sanitizeForLog,
} from '@/lib/utils/server/log/logSanitization';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktoken/tiktokenCache';
import { resolveChatRegion } from '@/lib/utils/shared/modelRegion';
import { UserRegion } from '@/lib/utils/shared/region';

import { RequestTelemetry } from '@/lib/types/logging';
import { ApprovalResponse, Message } from '@/types/chat';
import { ExtractionResponseFormat } from '@/types/extractionRecipe';
import { McpPendingToolCall, McpPlan } from '@/types/mcp';
import { OpenAIModel } from '@/types/openai';
import { Citation } from '@/types/rag';
import { Tone } from '@/types/tone';

import { ModelSelector, StreamingService, ToneService } from '../shared';
import { AnthropicFoundryHandler } from './handlers/AnthropicFoundryHandler';
import { HandlerFactory } from './handlers/HandlerFactory';
import { ResponsesApiHandler } from './handlers/ResponsesApiHandler';
import {
  CodeInterpreterInputFile,
  persistContainerFiles,
} from './tools/CodeInterpreterTool';

import { env } from '@/config/environment';
import { ResolvedMcpServer } from '@/config/mcpCatalog';
import { getFallbackModel, isDeploymentNotFoundError } from '@/config/models';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { TokenCredential, getBearerTokenProvider } from '@azure/identity';
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
 * Per-request routing for a custom-source (byom) model: the user's own
 * Foundry account endpoint plus their own credential, both resolved and
 * allow-list-checked by the credential middleware.
 */
export interface CustomSourceRouting {
  /** Account data-plane base, e.g. https://{account}.services.ai.azure.com */
  endpoint: string;
  /** Per-user credential bound by the credential middleware. */
  credential: TokenCredential;
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
  /** Per-request agent + correlation telemetry (see ChatContext.telemetry). */
  telemetry?: RequestTelemetry;
  transcript?: TranscriptMetadata;
  citations?: Citation[]; // Web search citations to include in response
  tone?: Tone; // Full tone object from client
  pendingTranscriptions?: PendingTranscriptionInfo[]; // Async batch transcription jobs
  streamingSpeed?: StreamingSpeedConfig; // Smooth streaming speed configuration
  /** Requested hosting region (cross-region routing); EU users are forced to EU. */
  hostedRegion?: UserRegion;
  /**
   * Native MCP tool loop inputs (already catalog-resolved + SSRF-guarded by
   * StandardChatHandler). Empty/absent = MCP inactive, zero behavior change.
   */
  mcpServers?: ResolvedMcpServer[];
  mcpPendingToolCalls?: McpPendingToolCall[];
  mcpLoopRound?: number;
  /**
   * In-process executor for `provenance: 'builtin'` entries in mcpServers
   * (the M365 toolset). Built by StandardChatHandler, request-bound — never
   * cached across requests.
   */
  builtinExecutor?: M365BuiltinExecutor;
  /**
   * Admin-configured cap from `feature.mcp.roundsPerRequest` (docs/LIMITS.md),
   * resolved once in createLimitsMiddleware. Absent → the compiled default.
   */
  mcpMaxRounds?: number;
  /**
   * Models this caller is blocked from by admin usage limits
   * (docs/LIMITS.md). Excluded from the DeploymentNotFound fallback chain so
   * a per-user model restriction cannot be routed around.
   */
  blockedModelIds?: string[];
  /** Turn plan echoed by the client on approval resume (re-sanitized here). */
  mcpPlan?: McpPlan;
  approvalResponses?: ApprovalResponse[];
  /**
   * Custom-source (byom) routing. When present, the service builds a
   * per-request client set against this endpoint/credential instead of the
   * region singletons, DISABLES the DeploymentNotFound fallback chain (no
   * silent reroute to app-hosted models), and skips hostedRegion resolution
   * (the endpoint is explicit — the user's own resource).
   */
  customSource?: CustomSourceRouting;
  /**
   * Native code interpreter for the Responses path (Phase 2): attach the
   * `code_interpreter` tool in-turn instead of the enricher round-trip.
   * `inputFiles` are raw attachment bytes; `session` scopes generated-file
   * persistence to the user's blob storage. Never log this object.
   */
  nativeCodeInterpreter?: {
    forced: boolean;
    inputFiles: CodeInterpreterInputFile[];
    session: Session;
  };
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
   * Builds a one-off client set for a custom-source (byom) request. All three
   * SDK paths authenticate with the USER's credential against the USER's own
   * account — the app's default/region clients are never touched, so a byom
   * request can't silently execute against an app-hosted deployment.
   *
   * The OpenAI-compatible client has no token-provider hook, so a bearer is
   * fetched up front (best effort — an auth failure surfaces to the user).
   */
  private async buildCustomSourceClients(source: CustomSourceRouting): Promise<{
    azureOpenAIClient: AzureOpenAI;
    openAIClient: OpenAI;
    anthropicFoundryClient: AnthropicFoundry;
  }> {
    const tokenProvider = getBearerTokenProvider(
      source.credential,
      'https://cognitiveservices.azure.com/.default',
    );
    const bearer = await tokenProvider();
    return {
      // The Azure OpenAI SDK targets the Cognitive Services alias of the
      // same account (Foundry accounts expose both hostnames).
      azureOpenAIClient: new AzureOpenAI({
        endpoint: source.endpoint.replace(
          '.services.ai.azure.com',
          '.cognitiveservices.azure.com',
        ),
        azureADTokenProvider: tokenProvider,
        apiVersion: OPENAI_API_VERSION,
      }),
      openAIClient: new OpenAI({
        baseURL: `${source.endpoint}/openai/v1/`,
        apiKey: bearer,
      }),
      anthropicFoundryClient: new AnthropicFoundry({
        azureADTokenProvider: async () => tokenProvider(),
        baseURL: `${source.endpoint}/anthropic`,
      }),
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
    telemetry?: RequestTelemetry,
  ): void {
    recordTokenUsage(usage, servedConfig, user, streamed, telemetry);
  }

  private recordToolCall(
    info: ToolCallTelemetry,
    modelConfig: OpenAIModel,
    user: Session['user'],
    telemetry?: RequestTelemetry,
  ): void {
    recordToolCall(info, modelConfig.id, user, telemetry);
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
    // Custom-source (byom) requests skip region resolution entirely — the
    // endpoint is explicit (the user's own resource) — and get a per-request
    // client set bound to the user's own credential.
    const customSource = request.customSource;
    const chatRegion = customSource
      ? null
      : resolveChatRegion(
          request.user?.region as UserRegion | undefined,
          request.hostedRegion,
        );
    const clients = customSource
      ? await this.buildCustomSourceClients(customSource)
      : this.resolveClients(chatRegion);
    if (customSource) {
      console.log(
        `[StandardChatService] Routing chat to custom-source endpoint: ${customSource.endpoint}`,
      );
    } else if (chatRegion) {
      console.log(
        `[StandardChatService] Routing chat to ${chatRegion} region endpoints`,
      );
    }

    // Claude + MCP: native Anthropic tool loop (streaming, tools-capable
    // models only — the same gate the OpenAI-family branch below applies).
    // Non-stream or non-supportsTools Claude falls through to the plain
    // Anthropic path with MCP silently ignored.
    // Turn-planning inputs for MCP loops: the last user message's text (for
    // the planner) and the client-echoed plan (approval resume), defensively
    // re-sanitized — it round-trips through the browser.
    const mcpUserMessageText = this.lastUserMessageText(messagesToSend);
    const mcpExistingPlan = request.mcpPlan
      ? (sanitizeMcpPlan(request.mcpPlan) ?? undefined)
      : undefined;
    const mcpPlanner = (
      userMessage: string,
      serversWithTools: Parameters<typeof planMcpSteps>[2],
    ) => planMcpSteps(this.openAIClient, userMessage, serversWithTools);

    if (
      HandlerFactory.isAnthropicModel(modelConfig) &&
      request.mcpServers?.length &&
      stream &&
      modelConfig.supportsTools
    ) {
      return this.handleAnthropicMcpChat(
        messagesToSend,
        modelConfig,
        // Tell the model its connectors are real and how the tool loop
        // behaves (approval pauses, denials, round budget).
        appendMcpSystemContext(enhancedPrompt, request.mcpServers),
        temperature,
        request,
        clients.anthropicFoundryClient,
        chatRegion,
        {
          planner: mcpPlanner,
          existingPlan: mcpExistingPlan,
          userMessageText: mcpUserMessageText,
        },
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
        request.telemetry,
        request.reasoningEffort,
      );
    }

    // Native MCP tool loop — only when the request carries resolved servers,
    // we're streaming, and the model does tool calling. Everything else
    // (non-stream, unsupported model like DeepSeek R1) silently ignores MCP
    // and takes the plain path below. Note: MCP turns deliberately opt out
    // of the DeploymentNotFound fallback chain (v1 simplification) — a
    // missing deployment surfaces as an error instead of falling back.
    if (request.mcpServers?.length && stream && modelConfig.supportsTools) {
      const handler = HandlerFactory.getHandler(
        modelConfig,
        clients.azureOpenAIClient,
        clients.openAIClient,
      );
      const preparedMessages = handler.prepareMessages(
        messagesToSend,
        // Tell the model its connectors are real and how the tool loop
        // behaves (approval pauses, denials, round budget).
        appendMcpSystemContext(enhancedPrompt, request.mcpServers),
        modelConfig,
      );
      const mcpEffort = modelConfig.supportsReasoningEffort
        ? request.reasoningEffort
        : undefined;
      console.log(
        `[StandardChatService] MCP tool loop active (${request.mcpServers.length} servers, round ${request.mcpLoopRound ?? 0}) for ${sanitizeForLog(modelConfig.id)}`,
      );
      return runMcpToolLoop({
        handler,
        preparedMessages,
        buildParams: (msgs) =>
          handler.buildRequestParams(
            handler.getModelIdForRequest(modelConfig.id, modelConfig),
            msgs,
            temperature,
            request.user,
            true,
            modelConfig,
            request.reasoningEffort,
            request.verbosity,
          ) as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        servers: request.mcpServers,
        builtinExecutor: request.builtinExecutor,
        pendingToolCalls: request.mcpPendingToolCalls,
        approvalResponses: request.approvalResponses,
        loopRound: request.mcpLoopRound ?? 0,
        maxRounds: request.mcpMaxRounds,
        userId: request.user?.id ?? request.user?.mail ?? 'unknown',
        citations: request.citations,
        planner: mcpPlanner,
        existingPlan: mcpExistingPlan,
        userMessageText: mcpUserMessageText,
        onToolCall: (info) =>
          this.recordToolCall(
            info,
            modelConfig,
            request.user,
            request.telemetry,
          ),
        usage: {
          modelId: modelConfig.id,
          region: chatRegion,
          reasoningEffort: mcpEffort,
          onUsage: (usage) =>
            this.recordUsage(
              usage,
              modelConfig,
              request.user,
              true,
              request.telemetry,
            ),
        },
      });
    }

    // Responses API path — flagged azure-openai models (GPT reasoning
    // family). Exposes reasoning summaries as visible thinking, which
    // chat.completions never returns. Custom-source (byom) requests stay on
    // chat.completions (their per-request clients aren't validated for the
    // Responses surface). Failures before the stream starts degrade to the
    // chat.completions path below — the flag is a preference, never a wall.
    if (
      modelConfig.supportsResponsesApi &&
      modelConfig.sdk === 'azure-openai' &&
      !customSource
    ) {
      // A missing deployment (catalog model not deployed on this endpoint)
      // must not silently cost the turn its native code interpreter: retry
      // the RESPONSES path on the fallback chain so the sandbox tool
      // survives the model switch. Only when no Responses-capable fallback
      // remains does the turn degrade to chat.completions below.
      let responsesConfig: OpenAIModel = modelConfig;
      const responsesAttempted: string[] = [];
      for (;;) {
        responsesAttempted.push(responsesConfig.id);
        try {
          return await this.handleResponsesApiChat(
            messagesToSend,
            responsesConfig,
            enhancedPrompt,
            temperature,
            stream,
            request,
            clients.azureOpenAIClient ?? this.azureOpenAIClient,
            chatRegion,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (isDeploymentNotFoundError(error)) {
            const fallback = getFallbackModel(
              responsesAttempted,
              request.blockedModelIds,
            );
            if (
              fallback?.supportsResponsesApi &&
              fallback.sdk === 'azure-openai'
            ) {
              console.warn(
                `[StandardChatService] Responses deployment for ${sanitizeForLog(responsesConfig.id)} not found; retrying Responses path on ${sanitizeForLog(fallback.id)}.`,
              );
              // TEMP DEBUG (see devTrace.ts) — DELETE before merge.
              devTrace('responses-deployment-fallback', {
                from: responsesConfig.id,
                to: fallback.id,
              });
              responsesConfig = fallback;
              continue;
            }
          }
          console.warn(
            `[StandardChatService] Responses API failed for ${sanitizeForLog(responsesConfig.id)}; falling back to chat.completions:`,
            message,
          );
          // TEMP DEBUG (see devTrace.ts) — DELETE before merge. A silent
          // drop to chat.completions also silently drops the interpreter.
          devTrace('responses-path-fallback', {
            model: responsesConfig.id,
            error: message.slice(0, 300),
          });
          break;
        }
      }
    }

    // A turn that staged the native interpreter but degraded to
    // chat.completions has NO execution tool — while the system prompt's
    // interpreter section still advertises file generation. Withdraw the
    // claim explicitly, or the model narrates having "created" files it
    // cannot possibly produce.
    const effectiveSystemPrompt = request.nativeCodeInterpreter
      ? `${enhancedPrompt}\n\nIMPORTANT: Code execution and file generation are NOT available for this response. Do not claim to have run code or created/saved any files. If the request requires producing a file, say that file generation is temporarily unavailable and provide the content inline instead.`
      : enhancedPrompt;

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
        effectiveSystemPrompt,
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
        // Custom-source requests never fall back: a missing deployment on the
        // user's own account must surface, not silently reroute to app models.
        if (customSource || !isDeploymentNotFoundError(error)) throw error;

        const fallback = getFallbackModel(
          attemptedModelIds,
          request.blockedModelIds,
        );
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
          request.telemetry,
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
          request.telemetry,
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
   * Plain chat over the Azure OpenAI Responses API (flagged models).
   * Reasoning summaries stream live as inline <think> text; usage and
   * citations ride the same terminal metadata block as chat.completions.
   * Throws on pre-stream failures so the caller can degrade to the
   * chat.completions path.
   */
  private async handleResponsesApiChat(
    messages: Message[],
    modelConfig: OpenAIModel,
    systemPrompt: string,
    temperature: number,
    stream: boolean,
    request: StandardChatRequest,
    client: AzureOpenAI,
    chatRegion: UserRegion | null,
  ): Promise<Response> {
    const handler = new ResponsesApiHandler(client);
    const input = handler.prepareInput(messages);
    const appliedEffort = modelConfig.supportsReasoningEffort
      ? request.reasoningEffort
      : undefined;

    // Native code interpreter (Phase 2): upload the raw attachments and
    // attach the tool in-turn. env gate re-checked here — the client toggle
    // alone must never enable execution. Streaming only: the non-streaming
    // path has no post-stream hook to persist container files, so it keeps
    // plain chat (the enricher round-trip covers non-streaming turns).
    const nativeCI =
      request.nativeCodeInterpreter && env.CODE_INTERPRETER_ENABLED && stream
        ? request.nativeCodeInterpreter
        : undefined;
    const ciFileIds = nativeCI
      ? await handler.uploadInputFiles(nativeCI.inputFiles)
      : [];

    // TEMP DEBUG (see devTrace.ts) — DELETE before merge.
    devTrace('native-ci', {
      requested: !!request.nativeCodeInterpreter,
      active: !!nativeCI,
      inputFiles: nativeCI?.inputFiles.map((f) => f.filename) ?? [],
      uploadedFileIds: ciFileIds.length,
      forced: nativeCI?.forced ?? false,
    });

    const params = handler.buildRequestParams(
      modelConfig,
      input,
      systemPrompt,
      temperature,
      stream,
      appliedEffort,
      modelConfig.supportsVerbosity ? request.verbosity : undefined,
      nativeCI
        ? {
            fileIds: ciFileIds,
            filenames: nativeCI.inputFiles.map((f) => f.filename),
            forced: nativeCI.forced,
          }
        : undefined,
    );

    console.log(
      `[StandardChatService] Using ResponsesApiHandler for model: ${sanitizeForLog(modelConfig.id)} (effort: ${appliedEffort ?? 'default'}, codeInterpreter: ${nativeCI ? 'native' : 'off'})`,
    );

    if (stream) {
      let events: Awaited<ReturnType<typeof handler.executeStreaming>>;
      try {
        events = await handler.executeStreaming(params);
      } catch (error) {
        // The uploads outlive a failed create call — clean up before the
        // caller retries on a fallback deployment (which re-uploads).
        if (ciFileIds.length > 0) void handler.deleteInputFiles(ciFileIds);
        throw error;
      }
      const processedStream = createResponsesStreamProcessor(
        events,
        request.transcript,
        request.citations,
        request.pendingTranscriptions,
        {
          modelId: modelConfig.id,
          region: chatRegion,
          reasoningEffort: appliedEffort,
          onUsage: (usage) =>
            this.recordUsage(
              usage,
              modelConfig,
              request.user,
              true,
              request.telemetry,
            ),
        },
        nativeCI
          ? {
              persistFiles: async (citations) => {
                try {
                  return await persistContainerFiles(
                    client as unknown as OpenAI,
                    citations,
                    nativeCI.session,
                  );
                } finally {
                  // Inputs were copied into the container; clean up the
                  // Foundry file-storage originals once the run is done.
                  void handler.deleteInputFiles(ciFileIds);
                }
              },
            }
          : undefined,
        // The processor reports mid-stream failures in-band to the client
        // with a generic message; the raw upstream detail is only durable
        // here (console output is not collected in production).
        (failure) =>
          void getAzureMonitorLogger().logError({
            user: request.user,
            errorCode: failure.code,
            errorMessage: failure.detail,
            operation: 'responsesStream',
            model: modelConfig.id,
          }),
      );
      return new Response(processedStream, {
        headers: STREAMING_RESPONSE_HEADERS,
      });
    }

    const completion = await handler.executeNonStreaming(params);
    const thinking = handler.extractReasoningSummary(completion);

    let usage: TokenUsageMetadata | undefined;
    if (completion.usage) {
      usage = {
        promptTokens: completion.usage.input_tokens ?? 0,
        completionTokens: completion.usage.output_tokens ?? 0,
        totalTokens: completion.usage.total_tokens ?? 0,
        modelId: modelConfig.id,
        region: chatRegion,
        reasoningEffort: appliedEffort,
      };
      this.recordUsage(
        usage,
        modelConfig,
        request.user,
        false,
        request.telemetry,
      );
    }

    return new Response(
      JSON.stringify({
        text: completion.output_text,
        ...(thinking ? { thinking } : {}),
        ...(usage ? { usage } : {}),
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  /**
   * Handles chat requests for Anthropic Claude models.
   * Uses the Anthropic Messages API which has a different structure than OpenAI.
   */
  /**
   * Claude + native MCP: mirrors handleAnthropicChat's preamble (client
   * resolution, handler construction, message prep) and hands off to the
   * Anthropic tool loop. Kept separate so the plain Anthropic path stays
   * byte-identical when MCP is inactive.
   */
  private async handleAnthropicMcpChat(
    messages: Message[],
    modelConfig: OpenAIModel,
    systemPrompt: string,
    temperature: number,
    request: StandardChatRequest,
    anthropicClient: AnthropicFoundry | undefined,
    chatRegion: UserRegion | null,
    planning?: {
      planner: Parameters<typeof runAnthropicMcpToolLoop>[0]['planner'];
      existingPlan?: McpPlan;
      userMessageText?: string;
    },
  ): Promise<Response> {
    const client = anthropicClient ?? this.anthropicFoundryClient;
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
    const preparedMessages = handler.prepareMessages(messages, modelConfig);
    console.log(
      `[StandardChatService] MCP tool loop active (${request.mcpServers?.length ?? 0} servers, round ${request.mcpLoopRound ?? 0}) for Anthropic model ${sanitizeForLog(modelConfig.id)}`,
    );

    return runAnthropicMcpToolLoop({
      handler,
      preparedMessages,
      buildParams: (msgs) =>
        handler.buildStreamingRequestParams(
          modelConfig.id,
          msgs,
          systemPrompt,
          temperature,
          request.user,
          modelConfig,
        ),
      servers: request.mcpServers ?? [],
      builtinExecutor: request.builtinExecutor,
      pendingToolCalls: request.mcpPendingToolCalls,
      approvalResponses: request.approvalResponses,
      loopRound: request.mcpLoopRound ?? 0,
      maxRounds: request.mcpMaxRounds,
      userId: request.user?.id ?? request.user?.mail ?? 'unknown',
      citations: request.citations,
      planner: planning?.planner,
      existingPlan: planning?.existingPlan,
      userMessageText: planning?.userMessageText,
      onToolCall: (info) =>
        this.recordToolCall(info, modelConfig, request.user, request.telemetry),
      usage: {
        modelId: modelConfig.id,
        region: chatRegion,
        onUsage: (usage) =>
          this.recordUsage(
            usage,
            modelConfig,
            request.user,
            true,
            request.telemetry,
          ),
      },
    });
  }

  /** Text of the last user message, for the MCP turn planner. */
  private lastUserMessageText(messages: Message[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        const text = message.content
          .map((c) => (c.type === 'text' && 'text' in c ? c.text : ''))
          .filter(Boolean)
          .join('\n');
        return text || undefined;
      }
      return undefined;
    }
    return undefined;
  }

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
    telemetry?: RequestTelemetry,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
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
        reasoningEffort,
      );

      // Execute streaming request
      const response = await handler.executeStreamingRequest(requestParams);

      // Process the stream with Anthropic-specific processor. Claude models
      // don't use the fallback chain, so modelConfig IS the served model.
      // reasoningEffort here reflects the extended-thinking budget tier the
      // handler applied (undefined/minimal = thinking off).
      const processedStream = createAnthropicStreamProcessor(
        response,
        undefined, // stopConversationRef
        transcript,
        citations,
        {
          modelId: modelConfig.id,
          region: chatRegion,
          reasoningEffort:
            modelConfig.supportsExtendedThinking &&
            reasoningEffort &&
            reasoningEffort !== 'minimal'
              ? reasoningEffort
              : undefined,
          onUsage: (usage) =>
            this.recordUsage(usage, modelConfig, user, true, telemetry),
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
        reasoningEffort,
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
        this.recordUsage(
          responseData.usage,
          modelConfig,
          user,
          false,
          telemetry,
        );
      }

      return new Response(JSON.stringify(responseData), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
