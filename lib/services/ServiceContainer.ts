import { OPENAI_API_VERSION } from '@/lib/utils/app/const';

import { AIFoundryAgentHandler } from './chat/AIFoundryAgentHandler';
import { AgentChatService } from './chat/AgentChatService';
import { FileProcessingService } from './chat/FileProcessingService';
import { StandardChatService } from './chat/StandardChatService';
import { ToolRouterService } from './chat/ToolRouterService';
import { CodeInterpreterFileService } from './chat/codeInterpreter/CodeInterpreterFileService';
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

  // Core services (stateless, safe to reuse)
  private modelSelector!: ModelSelector;
  private toneService!: ToneService;
  private streamingService!: StreamingService;
  private fileProcessingService!: FileProcessingService;
  private toolRouterService!: ToolRouterService;
  private agentChatService!: AgentChatService;
  private aiFoundryAgentHandler!: AIFoundryAgentHandler;
  private codeInterpreterFileService!: CodeInterpreterFileService;

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
    this.aiFoundryAgentHandler = new AIFoundryAgentHandler();
    this.codeInterpreterFileService = new CodeInterpreterFileService();

    // 4. Initialize chat service (uses multiple dependencies)
    this.standardChatService = new StandardChatService(
      this.azureOpenAIClient,
      this.openAIClient,
      this.anthropicFoundryClient,
      this.modelSelector,
      this.toneService,
      this.streamingService,
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

  public getCodeInterpreterFileService(): CodeInterpreterFileService {
    return this.codeInterpreterFileService;
  }
}
