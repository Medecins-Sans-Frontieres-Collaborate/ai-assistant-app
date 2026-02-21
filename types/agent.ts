import { Session } from 'next-auth';

import { Message } from './chat';
// =============================================================================
// PIPELINE AGENT CAPABILITIES
// =============================================================================
import { CodeInterpreterFile } from './codeInterpreter';
import { OpenAIModel } from './openai';

/**
 * Configuration for web search agents
 */
export interface WebSearchConfig {
  /** Search provider settings */
  provider?: string;
  /** API key or credentials */
  credentials?: Record<string, any>;
  /** Additional search parameters */
  [key: string]: any;
}

/**
 * Configuration for URL pull agents
 */
export interface UrlPullConfig {
  /** URL fetching settings */
  fetchOptions?: Record<string, any>;
  /** Content extraction settings */
  extractionOptions?: Record<string, any>;
  /** Additional parameters */
  [key: string]: any;
}

/**
 * Configuration for code interpreter agents
 */
export interface CodeInterpreterConfig {
  /** Execution environment settings */
  runtime?: string;
  /** Security settings */
  securityOptions?: Record<string, any>;
  /** Additional parameters */
  [key: string]: any;
}

/**
 * Configuration for knowledge base agents
 */
export interface KnowledgeBaseConfig {
  /** Knowledge base connection settings */
  connection?: Record<string, any>;
  /** Search settings */
  searchOptions?: Record<string, any>;
  /** Additional parameters */
  [key: string]: any;
}

/**
 * Enumeration of all supported agent types
 */
export enum AgentType {
  WEB_SEARCH = 'web_search',
  CODE_INTERPRETER = 'code_interpreter',
  URL_PULL = 'url_pull',
  LOCAL_KNOWLEDGE = 'local_knowledge',
  STANDARD_CHAT = 'standard_chat',
  FOUNDRY = 'foundry',
  THIRD_PARTY = 'third_party',
  TRANSLATION = 'translation',
}

/**
 * Enumeration of agent execution environments
 */
export enum AgentExecutionEnvironment {
  FOUNDRY = 'foundry',
  CODE = 'code',
  THIRD_PARTY = 'third_party',
  LOCAL = 'local',
}

/**
 * Configuration interface for agent instances
 */
export interface AgentConfig {
  /** Unique identifier for the agent */
  id: string;
  /** Human-readable name for the agent */
  name: string;
  /** Type of agent */
  type: AgentType;
  /** Execution environment for the agent */
  environment: AgentExecutionEnvironment;
  /** OpenAI model configuration */
  modelId: string;
  /** System instructions for the agent */
  instructions: string;
  /** Available tools for the agent */
  tools: any[];
  /** Temperature setting for AI responses */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Timeout for agent execution in milliseconds */
  timeout?: number;
  /** Skip standard chat processing and return agent output directly */
  skipStandardChatProcessing?: boolean;
  /** Additional metadata for the agent */
  metadata?: Record<string, any>;
  /** Agent-specific configuration parameters */
  parameters?: Record<string, any>;
}

/**
 * Web Search Agent specific configuration
 */
export interface WebSearchAgentConfig extends AgentConfig {
  /** Web search configuration parameters */
  webSearchConfig: WebSearchConfig;
  /** Maximum search results to process */
  maxResults?: number;
  /** Default market for searches */
  defaultMarket?: string;
  /** Default safe search level */
  defaultSafeSearch?: 'Off' | 'Moderate' | 'Strict';
  /** Enable citation extraction */
  enableCitations?: boolean;
  /** Enable result caching */
  enableCaching?: boolean;
  /** Cache TTL in seconds */
  cacheTtl?: number;
}

/**
 * URL Pull Agent specific configuration
 */
export interface UrlPullAgentConfig extends AgentConfig {
  /** URL pull configuration parameters */
  urlPullConfig: UrlPullConfig;
  /** Maximum URLs to process in single request */
  maxUrls?: number;
  /** Timeout for URL processing in milliseconds */
  processingTimeout?: number;
  /** Enable parallel processing */
  enableParallelProcessing?: boolean;
  /** Concurrency limit for parallel processing */
  concurrencyLimit?: number;
  /** Enable content extraction and metadata */
  enableContentExtraction?: boolean;
  /** Enable intelligent caching */
  enableCaching?: boolean;
  /** Cache TTL in seconds */
  cacheTtl?: number;
  /** Enable retry logic */
  enableRetry?: boolean;
  /** Maximum retry attempts */
  maxRetryAttempts?: number;
}

/**
 * Code Interpreter Agent specific configuration
 */
export interface CodeInterpreterAgentConfig extends AgentConfig {
  /** Code interpreter configuration parameters */
  codeInterpreterConfig: CodeInterpreterConfig;
  /** Maximum execution time in milliseconds */
  maxExecutionTime?: number;
  /** Maximum memory usage in MB */
  maxMemoryMb?: number;
  /** Enable code validation before execution */
  enableValidation?: boolean;
  /** Enable result caching */
  enableCaching?: boolean;
  /** Cache TTL in seconds */
  cacheTtl?: number;
  /** Enable file handling */
  enableFileHandling?: boolean;
  /** Maximum file size in MB */
  maxFileSizeMb?: number;
  /** Allowed programming languages */
  allowedLanguages?: string[];
  /** Enable security scanning */
  enableSecurityScanning?: boolean;
}

/**
 * Local Knowledge Agent Configuration
 */
export interface LocalKnowledgeAgentConfig extends AgentConfig {
  /** Knowledge base configuration parameters */
  knowledgeBaseConfig: KnowledgeBaseConfig;
  /** Maximum search results to return */
  maxResults?: number;
  /** Default search mode */
  defaultSearchMode?: 'semantic' | 'keyword' | 'hybrid';
  /** Enable access control */
  enableAccessControl?: boolean;
  /** Enable knowledge graph features */
  enableKnowledgeGraph?: boolean;
  /** Enable caching */
  enableCaching?: boolean;
  /** Cache TTL in seconds */
  cacheTtl?: number;
  /** Enable entity extraction */
  enableEntityExtraction?: boolean;
  /** Similarity threshold for semantic search */
  similarityThreshold?: number;
  /** Enable answer summarization */
  enableAnswerSummary?: boolean;
  /** Maximum answer summary length */
  maxSummaryLength?: number;
  /** Enable related document suggestions */
  enableRelatedSuggestions?: boolean;
  /** Enable analytics and metrics */
  enableAnalytics?: boolean;
}

/**
 * Translation Agent Configuration
 */
export interface TranslationAgentConfig extends AgentConfig {
  /** Default source language (if not specified, will be auto-detected) */
  defaultSourceLanguage?: string;
  /** Default target language (if not specified, will use user locale) */
  defaultTargetLanguage?: string;
  /** Enable automatic language detection */
  enableLanguageDetection?: boolean;
  /** Enable translation quality analysis */
  enableQualityAnalysis?: boolean;
  /** Enable result caching */
  enableCaching?: boolean;
  /** Cache TTL in seconds */
  cacheTtl?: number;
  /** Maximum text length for translation */
  maxTextLength?: number;
  /** Enable translation notes and context preservation */
  enableTranslationNotes?: boolean;
}

/**
 * Context provided to agents for execution
 */
export interface AgentExecutionContext {
  /** User query or request */
  query: string;
  /** Conversation history */
  messages: Message[];
  /** Optional conversation history as formatted strings for context */
  conversationHistory?: string[];
  /** User session information */
  user: Session['user'];
  /** Model configuration */
  model: OpenAIModel;
  /** User's locale */
  locale: string;
  /** User preferences and settings */
  userConfig?: Record<string, any>;
  /** Additional context parameters */
  context?: Record<string, any>;
  /** Request correlation ID */
  correlationId?: string;
}

/**
 * Standardized response format from agents
 */
export interface AgentResponse {
  /** Response content */
  content: string;
  /** Agent that generated the response */
  agentId: string;
  /** Agent type */
  agentType: AgentType;
  /** Execution success status */
  success: boolean;
  /** Structured content for further processing (e.g., extracted URL content, file data) */
  structuredContent?: {
    /** Type of structured content */
    type: 'url_content' | 'file_content' | 'data';
    /** Array of content items */
    items: Array<{
      /** Source identifier (URL, filename, etc.) */
      source: string;
      /** Extracted content */
      content: string;
      /** Content metadata */
      metadata?: {
        title?: string;
        contentType?: string;
        contentLength?: number;
        extractedAt?: string;
        [key: string]: any;
      };
    }>;
    /** Original user query for context */
    originalQuery?: string;
    /** Processing summary */
    summary?: {
      totalItems: number;
      successfulItems: number;
      failedItems: number;
      errors?: Array<{ source: string; error: string }>;
    };
  };
  /** Response metadata */
  metadata?: {
    /** Token usage information */
    tokenUsage?: {
      prompt: number;
      completion: number;
      total: number;
    };
    /** Processing time in milliseconds */
    processingTime?: number;
    /** Confidence score (0-1) */
    confidence?: number;
    /** Tool results */
    toolResults?: any[];
    /** Additional agent-specific metadata */
    agentMetadata?: Record<string, any>;
  };
  /** Error information if execution failed */
  error?: {
    /** Error code */
    code: string;
    /** Error message */
    message: string;
    /** Error details */
    details?: any;
  };
}

/**
 * Statistics for agent pool monitoring
 */
export interface AgentPoolStats {
  /** Agent type */
  agentType: AgentType;
  /** Total number of agents in pool */
  totalAgents: number;
  /** Number of active agents */
  activeAgents: number;
  /** Number of idle agents */
  idleAgents: number;
  /** Pool hit rate */
  hitRate: number;
  /** Pool miss rate */
  missRate: number;
  /** Average agent creation time */
  avgCreationTime: number;
  /** Average agent execution time */
  avgExecutionTime: number;
  /** Memory usage in bytes */
  memoryUsage: number;
  /** Last updated timestamp */
  lastUpdated: Date;
}

/**
 * Base interface for agent instances
 */
export interface BaseAgentInstance {
  /** Agent configuration */
  config: AgentConfig;
  /** Agent creation timestamp */
  createdAt: Date;
  /** Last used timestamp */
  lastUsed: Date;
  /** Agent health status */
  healthy: boolean;
  /** Number of times agent has been used */
  usageCount: number;
  /** Agent-specific state */
  state?: Record<string, any>;
  /** Execute agent with given context */
  execute(context: AgentExecutionContext): Promise<AgentResponse>;
  /** Check agent health */
  checkHealth(): Promise<AgentHealthResult>;
  /** Clean up agent resources */
  cleanup(): Promise<void>;
}

/**
 * Agent factory registration metadata
 */
export interface AgentFactoryRegistration {
  /** Agent type */
  type: AgentType;
  /** Factory function to create agents */
  factory: (config: AgentConfig) => Promise<BaseAgentInstance>;
  /** Agent capabilities */
  capabilities: string[];
  /** Supported models */
  supportedModels: string[];
  /** Configuration schema */
  configSchema?: Record<string, any>;
  /** Registration timestamp */
  registeredAt: Date;
}

/**
 * Agent health check result
 */
export interface AgentHealthResult {
  /** Agent ID */
  agentId: string;
  /** Health status */
  healthy: boolean;
  /** Health check timestamp */
  timestamp: Date;
  /** Response time in milliseconds */
  responseTime: number;
  /** Error message if unhealthy */
  error?: string;
  /** Additional health metrics */
  metrics?: Record<string, any>;
}

/**
 * Agent execution statistics
 */
export interface AgentExecutionStats {
  /** Agent ID */
  agentId: string;
  /** Total executions */
  totalExecutions: number;
  /** Successful executions */
  successfulExecutions: number;
  /** Failed executions */
  failedExecutions: number;
  /** Average execution time */
  avgExecutionTime: number;
  /** Total tokens used */
  totalTokens: number;
  /** Last execution timestamp */
  lastExecution: Date;
  /** Error rate */
  errorRate: number;
}

/**
 * Agent factory configuration
 */
export interface AgentFactoryConfig {
  /** Maximum pool size per agent type */
  maxPoolSize: number;
  /** Pool cleanup interval in milliseconds */
  cleanupInterval: number;
  /** Agent idle timeout in milliseconds */
  idleTimeout: number;
  /** Health check interval in milliseconds */
  healthCheckInterval: number;
  /** Default agent timeout in milliseconds */
  defaultTimeout: number;
  /** Enable metrics collection */
  enableMetrics: boolean;
  /** Enable health monitoring */
  enableHealthMonitoring: boolean;
}

/**
 * Agent validation result
 */
export interface AgentValidationResult {
  /** Validation success status */
  valid: boolean;
  /** Validation errors */
  errors: string[];
  /** Validation warnings */
  warnings: string[];
  /** Validated configuration */
  validatedConfig?: AgentConfig;
}

/**
 * Agent discovery query
 */
export interface AgentDiscoveryQuery {
  /** Agent type filter */
  type?: AgentType;
  /** Environment filter */
  environment?: AgentExecutionEnvironment;
  /** Capability filter */
  capabilities?: string[];
  /** Model filter */
  model?: string;
  /** Availability filter */
  available?: boolean;
}

/**
 * Agent discovery result
 */
export interface AgentDiscoveryResult {
  /** Agent type */
  type: AgentType;
  /** Agent environment */
  environment: AgentExecutionEnvironment;
  /** Agent capabilities */
  capabilities: string[];
  /** Supported models */
  supportedModels: string[];
  /** Availability status */
  available: boolean;
  /** Pool statistics */
  poolStats?: AgentPoolStats;
  /** Registration metadata */
  registration: AgentFactoryRegistration;
}

/**
 * Execution context validation result
 */
export interface ContextValidationResult {
  /** Validation success status */
  valid: boolean;
  /** Validation errors */
  errors: string[];
  /** Sanitized context */
  sanitizedContext?: AgentExecutionContext;
}

/**
 * Agent execution request
 */
export interface AgentExecutionRequest {
  /** Agent type to execute */
  agentType: AgentType;
  /** Execution context */
  context: AgentExecutionContext;
  /** Request priority */
  priority?: 'low' | 'normal' | 'high';
  /** Request timeout override */
  timeout?: number;
  /** Request-specific configuration */
  config?: Partial<AgentConfig>;
}

/**
 * Agent execution result
 */
export interface AgentExecutionResult {
  /** Execution request */
  request: AgentExecutionRequest;
  /** Agent response */
  response: AgentResponse;
  /** Execution start time */
  startTime: Date;
  /** Execution end time */
  endTime: Date;
  /** Total execution time in milliseconds */
  executionTime: number;
  /** Agent instance used */
  agentInstance: BaseAgentInstance;
}

/**
 * Capabilities enabled for an agent execution in the chat pipeline.
 *
 * This interface tracks what tools/features are enabled for a specific
 * agent execution. Different agents may have different tools enabled,
 * and this allows the pipeline to handle them uniformly.
 *
 * Key Insight: Code Interpreter is an agent capability, not a separate
 * execution mode. An agent can have multiple capabilities (e.g., Bing
 * grounding + Code Interpreter in the future).
 */
export interface AgentCapabilities {
  /**
   * Code Interpreter tool for Python execution.
   * When enabled, files are uploaded to AI Foundry and attached to messages.
   */
  codeInterpreter?: {
    /** Whether Code Interpreter is enabled for this execution */
    enabled: boolean;
    /** Files uploaded to AI Foundry for Code Interpreter use */
    uploadedFiles: CodeInterpreterFile[];
  };

  /**
   * Bing grounding for web search.
   * Agents with agentId typically have this enabled by default.
   */
  bingGrounding?: {
    /** Whether Bing grounding is enabled */
    enabled: boolean;
  };

  // Future capabilities can be added here:
  // fileSearch?: { enabled: boolean; vectorStoreIds: string[] };
  // functionCalling?: { enabled: boolean; functions: FunctionDefinition[] };
}
