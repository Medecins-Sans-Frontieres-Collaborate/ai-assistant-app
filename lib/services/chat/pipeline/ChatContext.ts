import { Session } from 'next-auth';

import { ModelSelector } from '@/lib/services/shared';

import { Message } from '@/types/chat';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import { Tone } from '@/types/tone';

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

  /** Transcripts from audio/video files */
  transcripts?: {
    filename: string;
    transcript: string;
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
