import { Session } from 'next-auth';

import { M365Agent, PromptAgent } from '@/lib/services/agentAccess/types';
import { ModelSelector } from '@/lib/services/shared';

import { ActiveFile, ApprovalResponse, Message } from '@/types/chat';
import {
  ExtractionRequest,
  ExtractionResponseFormat,
} from '@/types/extractionRecipe';
import { InterpreterMode } from '@/types/interpreterMode';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import { DisplayNamePreference } from '@/types/settings';
import { Tone } from '@/types/tone';
import { WebSearchOptions } from '@/types/webSearch';

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

  /**
   * Best-effort summary of earlier messages dropped by client-side context
   * windowing (conversation compaction). Rendered into the system prompt.
   */
  conversationSummary?: string;

  /**
   * Long-term user memory snippets (Memories feature). Rendered into the
   * system prompt.
   */
  memories?: string[];

  /** Display name preference from General Settings (for deriving name fallback) */
  displayNamePreference?: DisplayNamePreference;

  /** Custom display name from General Settings */
  customDisplayName?: string;

  /**
   * ARM resource path of the Foundry project that hosts the agent being
   * invoked. Set by the client when calling a specific foundry agent; the
   * server validates against `isValidFoundryResourcePath` before use; invalid → ignored.
   */
  agentSourcePath?: string;

  /**
   * ARM ACCOUNT path of the user-added custom model source ("BYO model")
   * hosting the selected `byom-*` model. Set by the client; the credential
   * middleware validates it and re-resolves the model under the user's own
   * ARM OBO token — the value is never trusted as-is.
   */
  modelSourcePath?: string;

  /**
   * MCP tool-approval responses to submit alongside (or in lieu of) the
   * user's new message. When present, the Foundry agent handler skips
   * creating a new user-message conversation item and instead posts
   * `mcp_approval_response` items to resume the agent.
   */
  approvalResponses?: ApprovalResponse[];

  /**
   * Native MCP tool loop (direct SDK paths, NOT the Foundry agent path):
   * user-configured MCP servers whose tools the model may call this turn,
   * plus the previous round's pending tool calls and the loop round counter
   * for the stateless pause/resume protocol. Entries may carry auth tokens —
   * never log these objects.
   */
  mcpServers?: import('@/types/mcp').McpServerRequestEntry[];
  mcpPendingToolCalls?: import('@/types/mcp').McpPendingToolCall[];
  mcpLoopRound?: number;
  /** Turn plan echoed by the client on approval resume. */
  mcpPlan?: import('@/types/mcp').McpPlan;

  // ========================================
  // FEATURE FLAGS
  // ========================================
  /** Bot/knowledge base ID for RAG */
  botId?: string;

  /** Search mode for tool routing */
  searchMode?: SearchMode;

  /**
   * User-tunable search options (source count, freshness preference).
   * Validated/bounded by InputValidator; absent = defaults.
   */
  webSearchOptions?: WebSearchOptions;

  /**
   * "Summarize from headlines" resend: interim headlines the client already
   * received for this message, echoed back to be merged as THE search
   * result instead of running a fresh search. Validated/bounded by
   * InputValidator.
   */
  precomputedSearchResults?: import('@/types/webSearch').PrecomputedSearchResults;

  /**
   * Code-interpreter mode for tool routing (off / intelligent / always).
   * `always` is the user's "Run code" force toggle. Server-side the feature
   * is additionally gated by env.CODE_INTERPRETER_ENABLED.
   */
  interpreterMode?: InterpreterMode;

  /**
   * Set by ToolRouterEnricher when the PICKED model can run the
   * code_interpreter tool natively on the Responses path (Phase 2): the
   * enricher skips the sub-tool round-trip and StandardChatService attaches
   * the tool in-turn instead. `inputFiles` are the raw attachment bytes —
   * never log this object.
   */
  nativeCodeInterpreter?: {
    /** InterpreterMode.ALWAYS — the model is instructed to actually run code. */
    forced: boolean;
    inputFiles: import('../tools/CodeInterpreterTool').CodeInterpreterInputFile[];
  };

  /**
   * Requested hosting region for this conversation (cross-region routing).
   * Client preference only — resolveChatRegion enforces EU users → EU
   * server-side regardless of this value.
   */
  hostedRegion?: 'US' | 'EU';

  /** Whether agent mode is enabled */
  agentMode?: boolean;

  /**
   * App-defined prompt-agent persona resolved server-side from `botId`
   * (docs/AGENT_ACCESS_CONTROL.md). Set by createModelSelectionMiddleware
   * when the agent-access feature is enabled; drives PromptAgentEnricher's
   * system-prompt override and the credential middleware's access guard.
   * Never routes into the Foundry execution path (no agentId is ever set).
   */
  promptAgent?: PromptAgent;

  /**
   * M365 file-backed RAG agent resolved server-side from `botId`
   * (docs/M365_SECOND_PASS_AGENTS_DESIGN.md). Set by
   * createModelSelectionMiddleware; drives M365AgentEnricher's retrieval and
   * the credential middleware's two-layer access guard. Never routes into
   * the Foundry execution path.
   */
  m365Agent?: M365Agent;

  /**
   * Layer-2 trim result: the agent's source ids the REQUESTING USER'S own
   * Graph token can open, verified by the credential middleware. Retrieval
   * is hard-filtered to this subset — never read sources outside it.
   */
  m365AccessibleSourceIds?: string[];

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

  /** OBO credential for making Foundry calls as the authenticated user */
  userCredential?: TokenCredential;

  /** Regional Foundry endpoint resolved from user's region (GDPR routing) */
  foundryEndpoint?: string;

  /**
   * Optional async helper that pipeline stages can call to update the
   * client-visible loading text in real time. Each call writes a single
   * AGENT_ACTIVITY marker into the response stream. The route handler
   * installs this when it sets up the streaming response.
   */
  emitActivity?: (
    translationKey: string,
    params?: Record<string, string>,
  ) => Promise<void>;

  /**
   * Optional async helper to write a RAW pre-encoded stream marker (e.g. a
   * TOOL_CALL_RECORD from `lib/streamMarkers`) into the response stream.
   * Same transport as emitActivity; installed by the route handler. Used by
   * enrichers that complete a tool run BEFORE the model stream starts (code
   * interpreter) so the record reaches the client on the same channel the
   * MCP tool loop uses.
   */
  emitMarker?: (marker: string) => Promise<void>;

  // ========================================
  // PIPELINE STATE (Modified by stages)
  // ========================================
  /** Processed content (populated by content processors) */
  processedContent?: ProcessedContent;

  /** Enriched messages (populated by feature enrichers) */
  enrichedMessages?: Message[];

  /**
   * Active files to include in context (from client). The injector mutates
   * this collection in-place: selected files get their `lastUsedAt` bumped
   * to the current turn so they round-trip back to the client via the
   * normal SSE persistence path. The next turn's selection sort then sees
   * the updated timestamps and rotates files fairly across turns.
   */
  activeFiles?: ActiveFile[];

  /** Cache updates for active files (emitted as SSE events) */
  activeFilesCacheUpdates?: Array<{
    fileId: string;
    processedContent: NonNullable<ActiveFile['processedContent']>;
  }>;

  /** Cumulative active file tokens used so far (from client) */
  activeFilesTokensUsed?: number;
  /** Session quota for active files (from client, or default constant) */
  activeFilesSessionQuota?: number;
  /**
   * Whether pinned-image active files should be re-injected into this turn's
   * last user message. Default `true` if absent (set in InputValidator). When
   * `false`, pinned images still survive eviction (so they remain visible in
   * the active-files panel) but are not appended to the outgoing user
   * message — the model only sees them on turns where the user re-attaches
   * them. See `ActiveFileInjector` for the branch.
   */
  autoInjectPinnedImages?: boolean;
  /** Output: tokens injected this turn */
  activeFilesTokensConsumedThisTurn?: number;
  /**
   * Output: file IDs that were excluded from this turn's context because
   * they did not fit the per-turn budget. Surfaced to the client via SSE
   * (`StreamMetadata.activeFilesDropped`) and stored there as
   * `chatStore.lastTurnDroppedActiveFileIds[conversationId]`. The asymmetric
   * naming is deliberate: from this stage's perspective the exclusion is
   * happening "this turn", while the client only sees the result *after*
   * the turn completes — by then it's the "last turn" relative to the
   * next user send. Clear on successful population of the next turn's
   * dropped IDs (so a stream that fails mid-flight keeps the previous
   * badges visible).
   */
  activeFilesDroppedThisTurn?: string[];

  /**
   * Structured data extraction request, set by `InputValidator` from the
   * client's `extraction` payload. Triggers `ExtractionEnricher` to compose
   * the response format and route URLs through the existing WebSearchTool.
   */
  extraction?: ExtractionRequest;

  /**
   * Strict JSON-Schema response format, written by `ExtractionEnricher` and
   * consumed by `StandardChatHandler`. When present, the handler issues a
   * structured-output call (`response_format: { type: 'json_schema', ... }`)
   * and parses the JSON result into an `ExtractionResultContent` message.
   */
  responseFormat?: ExtractionResponseFormat;

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

  /**
   * Admin-configured usage limits already resolved for this caller and this
   * model (docs/LIMITS.md). Populated once by createLimitsMiddleware so
   * downstream enrichers and the MCP tool loop consult the SAME decision
   * rather than re-resolving — re-resolution mid-request could see a
   * different policy snapshot after a 60s TTL boundary.
   *
   * Undefined when the feature is disabled: every consumer must treat that
   * as "no limits", never as "blocked".
   */
  limits?: import('@/lib/services/limits/context').ChatLimits;
}

/**
 * Decides whether a request should execute via the Foundry-agent code path
 * (vs. the standard handler path). Centralized so the routing rule is
 * consistent across enrichers + the final handler dispatch.
 *
 * Files/images intentionally force the STANDARD path: the Foundry agent
 * handler flattens attachments to placeholder text ("[Image attached]"),
 * losing their content. This is NOT a capability gap for tools anymore —
 * the standard path runs web search and the code interpreter via
 * ToolRouterEnricher, and the interpreter receives the raw attached files.
 * Revisit for Phase 2 (native in-turn code interpreter) once the agent
 * path can carry real file payloads.
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
