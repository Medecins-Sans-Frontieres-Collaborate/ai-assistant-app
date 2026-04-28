import { Session } from 'next-auth';

import { ModelSelector } from '@/lib/services/shared';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import { DisplayNamePreference } from '@/types/settings';
import { Tone } from '@/types/tone';

import { TokenCredential } from '@azure/identity';

/**
 * Processed content from content processors.
 * Populated by FileProcessor, AudioProcessor, ImageProcessor.
 */
export interface ProcessedContent {
  /** Summarized file content (if files present) */
  fileSummaries?: {
    filename: string;
    summary: string;
    originalContent: string;
  }[];

  /** Inline file content for small files that don't need chunking */
  inlineFiles?: {
    filename: string;
    content: string;
  }[];

  /** Transcripts from audio/video files */
  transcripts?: {
    filename: string;
    transcript: string;
  }[];

  /** Pending transcription jobs (for files >25MB that use async processing) */
  pendingTranscriptions?: {
    filename: string;
    jobId: string;
    blobPath?: string; // Only for batch jobs
    totalChunks?: number; // Only for chunked jobs
    jobType?: 'chunked' | 'batch';
  }[];

  /** Validated image URLs (if images present) */
  images?: {
    url: string;
    detail: 'auto' | 'low' | 'high';
  }[];

  /** Any metadata from processing */
  metadata?: Record<string, any>;
}

/**
 * ChatContext holds ALL state for a chat request as it flows through the pipeline.
 *
 * This is the single source of truth for:
 * - Request data (messages, model, params)
 * - Authentication (session, user)
 * - Content analysis (what types of content are present)
 * - Processed content (after content processors run)
 * - Enriched messages (after feature enrichers run)
 * - Final response
 *
 * Each pipeline stage can read and modify this context.
 */
export interface ChatContext {
  // ========================================
  // AUTHENTICATION
  // ========================================
  /** Authenticated session */
  session: Session;

  /** User from session (convenience) */
  user: Session['user'];

  // ========================================
  // REQUEST DATA (Immutable after parsing)
  // ========================================
  /** Model to use (may be upgraded by ModelSelector) */
  model: OpenAIModel;

  /** Selected model ID (after selection/upgrade) */
  modelId: string;

  /** Conversation messages */
  messages: Message[];

  /** System prompt */
  systemPrompt: string;

  /** Temperature setting */
  temperature?: number;

  /** Whether to stream response */
  stream: boolean;

  /** Reasoning effort for reasoning models */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';

  /** Response verbosity */
  verbosity?: 'low' | 'medium' | 'high';

  /** Raw user prompt from request (before building full system prompt) */
  rawUserPrompt?: string;

  /** Whether to include user info in system prompt */
  includeUserInfoInPrompt?: boolean;

  /** User's preferred name (overrides profile displayName) */
  preferredName?: string;

  /** Additional user context for the AI */
  userContext?: string;

  /** Display name preference from General Settings (for deriving name fallback) */
  displayNamePreference?: DisplayNamePreference;

  /** Custom display name from General Settings */
  customDisplayName?: string;

  /**
   * ARM resource path of the Foundry project hosting the agent being invoked,
   * forwarded from the request body. Validated against
   * `isValidFoundryResourcePath` before use; invalid → ignored.
   */
  agentSourcePath?: string;

  // ========================================
  // FEATURE FLAGS
  // ========================================
  /** Bot/knowledge base ID for RAG */
  botId?: string;

  /** Search mode for tool routing */
  searchMode?: SearchMode;

  /** Whether agent mode is enabled */
  agentMode?: boolean;

  /** Thread ID for continuing conversations */
  threadId?: string;

  /** Forced agent type */
  forcedAgentType?: string;

  /** Tone configuration (voice/writing style) */
  tone?: Tone;

  /** Streaming speed configuration for smooth text output */
  streamingSpeed?: {
    charsPerBatch: number;
    delayMs: number;
  };

  // ========================================
  // CONTENT ANALYSIS (Populated by middleware)
  // ========================================
  /** All content types present in messages */
  contentTypes: Set<'text' | 'image' | 'file' | 'audio' | 'video'>;

  /** Whether files are present */
  hasFiles: boolean;

  /** Whether images are present */
  hasImages: boolean;

  /** Whether audio/video files are present */
  hasAudio: boolean;

  // ========================================
  // INJECTED SERVICES
  // ========================================
  /** Model selector instance */
  modelSelector: ModelSelector;

  // ========================================
  // PER-REQUEST CREDENTIALS (for Foundry agent calls)
  // ========================================
  /** OBO credential for making Foundry calls as the authenticated user */
  userCredential?: TokenCredential;

  /** Regional Foundry endpoint resolved from user's region (GDPR routing) */
  foundryEndpoint?: string;

  /**
   * Optional async helper that pipeline stages can call to update the
   * client-visible loading text in real time (e.g. "Searching the knowledge
   * base…"). Each call writes a single AGENT_ACTIVITY marker into the
   * response stream. The route handler installs this when it sets up the
   * streaming response; stages that don't need to emit anything ignore it.
   * The argument is a translation key from `messages/en.json#chat.activity`.
   */
  emitActivity?: (translationKey: string) => Promise<void>;

  // ========================================
  // PIPELINE STATE (Modified by stages)
  // ========================================
  /** Processed content (populated by content processors) */
  processedContent?: ProcessedContent;

  /** Enriched messages (populated by feature enrichers) */
  enrichedMessages?: Message[];

  /** Execution strategy (standard or agent) */
  executionStrategy?: 'standard' | 'agent';

  /** Final response (populated by execution handler) */
  response?: Response;

  /** Errors encountered during pipeline */
  errors?: Error[];

  /** Performance metrics */
  metrics?: {
    startTime: number;
    endTime?: number;
    stageTimings?: Map<string, number>;
  };

  /** Rate limit information (for response headers) */
  rateLimitInfo?: {
    allowed: boolean;
    count: number;
    limit: number;
    remaining: number;
    resetTime: number;
    retryAfter?: number;
  };
}

/**
 * Single source of truth for "is this request going to run as a Foundry
 * agent?" — used by AgentEnricher (to set executionStrategy='agent') and
 * by ToolRouterEnricher (to skip pre-routing when the agent will decide
 * for itself via its own tool calls). Keeping the predicate in one place
 * prevents the two enrichers from drifting apart.
 *
 * Currently agent mode requires text-only input — files/images fall back
 * to the standard handler path which still wants pre-routing.
 */
export function shouldExecuteAsAgent(
  context: Pick<ChatContext, 'agentMode' | 'model' | 'hasFiles' | 'hasImages'>,
): boolean {
  return (
    !!context.agentMode &&
    !!context.model?.agentId &&
    !context.hasFiles &&
    !context.hasImages
  );
}
