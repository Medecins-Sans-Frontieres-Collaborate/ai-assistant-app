import { OPENAI_API_VERSION } from '@/lib/utils/app/const';
import { UserRegion } from '@/lib/utils/shared/region';

import { AIFoundryAgentHandler } from './chat/AIFoundryAgentHandler';
import { AgentChatService } from './chat/AgentChatService';
import { FileProcessingService } from './chat/FileProcessingService';
import { StandardChatService } from './chat/StandardChatService';
import { ToolRouterService } from './chat/ToolRouterService';
import { ModelSelector, StreamingService, ToneService } from './shared';

import { env } from '@/config/environment';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import { AzureOpenAI } from 'openai';
import OpenAI from 'openai';

/**
 * Region-specific chat clients for cross-region routing. Every field is
 * optional: a missing client means "no region-specific configuration for
 * that SDK" and callers fall back to the default (region-blind) client, so a
 * partially configured region degrades instead of breaking chat.
 */
export interface RegionChatClients {
  azureOpenAIClient?: AzureOpenAI;
  openAIClient?: OpenAI;
  anthropicFoundryClient?: AnthropicFoundry;
}

/**
 * ServiceContainer provides singleton access to all application services.
 *
 * Benefits:
 * - Services are initialized once at startup, not per-request
 * - Reduces memory and CPU overhead significantly
 * - Enables connection pooling for Azure clients
 * - Improves performance by reusing expensive resources
 * - Thread-safe singleton pattern
 *
 * Usage:
 * ```typescript
 * const container = ServiceContainer.getInstance();
 * const chatService = container.getStandardChatService();
 * ```
 */
export class ServiceContainer {
  private static instance: ServiceContainer | null = null;

  // Azure clients (expensive to create, should be reused)
  private azureOpenAIClient!: AzureOpenAI;
  private openAIClient!: OpenAI;
  private anthropicFoundryClient!: AnthropicFoundry;

  // Lazily built per-region client sets for cross-region routing, cached for
  // the process lifetime like the default clients above.
  private regionChatClients = new Map<UserRegion, RegionChatClients>();
  private azureADTokenProvider!: () => Promise<string>;

  // Core services (stateless, safe to reuse)
  private modelSelector!: ModelSelector;
  private toneService!: ToneService;
  private streamingService!: StreamingService;
  private fileProcessingService!: FileProcessingService;
  private toolRouterService!: ToolRouterService;
  private agentChatService!: AgentChatService;
  private aiFoundryAgentHandler!: AIFoundryAgentHandler;

  // Chat service (uses all the above)
  private standardChatService!: StandardChatService;

  private constructor() {
    // Private constructor to prevent direct instantiation
  }

  /**
   * Gets the singleton instance of ServiceContainer.
   * Initializes services on first call.
   */
  public static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
      ServiceContainer.instance.initialize();
    }
    return ServiceContainer.instance;
  }

  /**
   * Initializes all services.
   * Called once when the singleton is first created.
   */
  private initialize(): void {
    console.log('[ServiceContainer] Initializing services...');

    // 1. Initialize Azure clients
    const azureADTokenProvider = getBearerTokenProvider(
      new DefaultAzureCredential(),
      'https://cognitiveservices.azure.com/.default',
    );
    // Kept for lazily-built per-region clients (getChatClientsForRegion).
    this.azureADTokenProvider = azureADTokenProvider;

    this.azureOpenAIClient = new AzureOpenAI({
      endpoint: env.AZURE_OPENAI_ENDPOINT,
      azureADTokenProvider,
      apiVersion: OPENAI_API_VERSION,
    });

    // OpenAI client for AI Foundry OpenAI-compatible endpoint (Grok, DeepSeek, etc.)
    // Note: AI Foundry's OpenAI-compatible endpoint currently requires API key
    // TODO: Investigate if token-based auth is supported
    this.openAIClient = new OpenAI({
      baseURL:
        env.AZURE_AI_FOUNDRY_OPENAI_ENDPOINT ||
        `${env.AZURE_AI_FOUNDRY_ENDPOINT?.replace('/api/projects/default', '')}/openai/v1/`,
      apiKey: env.OPENAI_API_KEY || 'placeholder', // Required by SDK even if not used
    });

    // Anthropic Foundry client for Claude models via Azure AI Foundry
    // Uses Entra ID authentication (same as Azure OpenAI)
    // Derives endpoint from AZURE_AI_FOUNDRY_ENDPOINT: https://<resource>.services.ai.azure.com/anthropic
    const anthropicBaseUrl = env.AZURE_AI_FOUNDRY_ENDPOINT?.replace(
      /\/api\/projects\/.*$/,
      '',
    );
    if (anthropicBaseUrl) {
      this.anthropicFoundryClient = new AnthropicFoundry({
        azureADTokenProvider: async () => azureADTokenProvider(),
        baseURL: `${anthropicBaseUrl}/anthropic`,
      });
    }

    // 2. Initialize stateless services
    this.modelSelector = new ModelSelector();
    this.toneService = new ToneService();
    this.streamingService = new StreamingService();
    this.fileProcessingService = new FileProcessingService();

    // 3. Initialize services that depend on clients
    this.toolRouterService = new ToolRouterService(this.openAIClient);
    this.agentChatService = new AgentChatService();
    // AIFoundryAgentHandler is stateless — credentials are passed per-request
    // from the pipeline context (OBO for Foundry agents, DefaultAzureCredential fallback)
    this.aiFoundryAgentHandler = new AIFoundryAgentHandler();

    // 4. Initialize chat service (uses multiple dependencies). The region
    // resolver is passed as a bound method so StandardChatService never
    // imports the container (avoids a dependency cycle, keeps tests simple).
    this.standardChatService = new StandardChatService(
      this.azureOpenAIClient,
      this.openAIClient,
      this.anthropicFoundryClient,
      this.modelSelector,
      this.toneService,
      this.streamingService,
      (region) => this.getChatClientsForRegion(region),
    );

    console.log('[ServiceContainer] Services initialized successfully');
  }

  /**
   * Resets the singleton instance.
   * Only use this for testing purposes.
   */
  public static reset(): void {
    ServiceContainer.instance = null;
  }

  /**
   * Returns (building + caching on first use) the chat clients pinned to a
   * specific region, for cross-region routing (a US user chatting with the
   * EU instance of a model; EU users pinned to EU).
   *
   * Endpoint resolution per region:
   *  - Azure OpenAI: AZURE_OPENAI_ENDPOINT_{REGION}, else derived from the
   *    regional Foundry endpoint (same account exposes both hosts:
   *    <account>.services.ai.azure.com ↔ <account>.cognitiveservices.azure.com).
   *  - OpenAI-compatible data plane: <regional foundry account>/openai/v1/ —
   *    only when a region-scoped API key exists (keys are account-scoped;
   *    reusing the default key against another account would 401).
   *  - Anthropic: <regional foundry account>/anthropic (Entra ID tokens are
   *    account-agnostic, so no extra secret is needed).
   *
   * Missing configuration never breaks chat: absent fields make callers fall
   * back to the default clients per-SDK.
   */
  public getChatClientsForRegion(region: UserRegion): RegionChatClients {
    const cached = this.regionChatClients.get(region);
    if (cached) return cached;

    const foundryEndpoint =
      region === 'EU'
        ? env.AZURE_AI_FOUNDRY_ENDPOINT_EU
        : env.AZURE_AI_FOUNDRY_ENDPOINT_US;
    const accountBase = foundryEndpoint?.replace(/\/api\/projects\/.*$/, '');

    const clients: RegionChatClients = {};

    const azureOpenAIEndpoint =
      (region === 'EU'
        ? env.AZURE_OPENAI_ENDPOINT_EU
        : env.AZURE_OPENAI_ENDPOINT_US) ??
      accountBase?.replace(
        '.services.ai.azure.com',
        '.cognitiveservices.azure.com',
      );
    if (azureOpenAIEndpoint) {
      clients.azureOpenAIClient = new AzureOpenAI({
        endpoint: azureOpenAIEndpoint,
        azureADTokenProvider: this.azureADTokenProvider,
        apiVersion: OPENAI_API_VERSION,
      });
    }

    const regionApiKey =
      region === 'EU' ? env.OPENAI_API_KEY_EU : env.OPENAI_API_KEY_US;
    if (accountBase && regionApiKey) {
      clients.openAIClient = new OpenAI({
        baseURL: `${accountBase}/openai/v1/`,
        apiKey: regionApiKey,
      });
    }

    if (accountBase) {
      clients.anthropicFoundryClient = new AnthropicFoundry({
        azureADTokenProvider: async () => this.azureADTokenProvider(),
        baseURL: `${accountBase}/anthropic`,
      });
    }

    if (Object.keys(clients).length === 0) {
      console.warn(
        `[ServiceContainer] No ${region} chat endpoints configured; requests for that region use the default clients`,
      );
    }

    this.regionChatClients.set(region, clients);
    return clients;
  }

  // Getters for all services

  public getAzureOpenAIClient(): AzureOpenAI {
    return this.azureOpenAIClient;
  }

  public getOpenAIClient(): OpenAI {
    return this.openAIClient;
  }

  public getAnthropicFoundryClient(): AnthropicFoundry {
    return this.anthropicFoundryClient;
  }

  public getModelSelector(): ModelSelector {
    return this.modelSelector;
  }

  public getToneService(): ToneService {
    return this.toneService;
  }

  public getStreamingService(): StreamingService {
    return this.streamingService;
  }

  public getFileProcessingService(): FileProcessingService {
    return this.fileProcessingService;
  }

  public getToolRouterService(): ToolRouterService {
    return this.toolRouterService;
  }

  public getAgentChatService(): AgentChatService {
    return this.agentChatService;
  }

  public getAIFoundryAgentHandler(): AIFoundryAgentHandler {
    return this.aiFoundryAgentHandler;
  }

  public getStandardChatService(): StandardChatService {
    return this.standardChatService;
  }
}
