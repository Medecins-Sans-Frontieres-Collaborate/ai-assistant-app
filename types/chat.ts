import {
  TokenUsageMetadata,
  TranscriptMetadata,
} from '@/lib/utils/app/metadata';

import { ExtractionRequest } from './extractionRecipe';
import { OpenAIModel } from './openai';
import { Citation } from './rag';
import { DisplayNamePreference, StreamingSpeedConfig } from './settings';
import { Tone } from './tone';

// Type-only import: erased at build time, so client bundles don't pull in
// lib/streamMarkers — but ToolCallRecord stays tied to its marker payload.
import type { ToolCallRecordPayload } from '@/lib/streamMarkers';

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  AUDIO = 'AUDIO',
  VIDEO = 'VIDEO',
  FILE = 'FILE',
}

export interface ImageMessageContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail: 'auto' | 'high' | 'low';
  };
}

export interface RequestResult {
  controller: AbortController;
  body: string;
  response: Response;
}

export interface ChatRequestResult extends RequestResult {
  hasComplexContent: boolean;
  setOnAbort?: (callback: () => void) => void;
}

/*
 * This is an arbitrary content type since we are just using it to handle
 * the retrieval and parsing on the server-side. This is unlike ImageMessageContent,
 * which is a genuine type that some gpt models can handle directly
 */
export interface FileMessageContent {
  type: 'file_url';
  url: string;
  originalFilename?: string;
  /** ISO-639-1 language code for transcription (e.g., 'en', 'es'). Undefined = auto-detect */
  transcriptionLanguage?: string;
  /** Optional context/instructions to improve transcription accuracy */
  transcriptionPrompt?: string;
}

export interface TextMessageContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
}

/**
 * Result of a structured-data-extraction turn (server-emitted only).
 *
 * `datasets` is the parsed JSON output of the strict json_schema call,
 * one entry per recipe in request-time order. `rows` is the array
 * returned by the model for that recipe; `fields` mirrors the recipe's
 * field list so the table renderer can lay out columns without round-
 * tripping to the client store.
 *
 * `proposedSchema` is set only in auto mode — the model invented a
 * structure for the material and the renderer offers "Save as recipe".
 */
export interface ExtractionDataset {
  recipeId: string;
  recipeName: string;
  fields: Array<{
    name: string;
    label?: string;
    type: string;
    required?: boolean;
  }>;
  rows: Array<Record<string, unknown>>;
  /** Auto-mode only: structure the model proposed. */
  proposedSchema?: {
    instructions?: string;
    fields: Array<{
      name: string;
      label?: string;
      type: string;
      required?: boolean;
      description?: string;
    }>;
  };
}

export interface ExtractionResultContent {
  type: 'extraction_result';
  datasets: ExtractionDataset[];
  /** Optional model-emitted note about the extraction (caveats, gaps). */
  note?: string;
}

export interface Message extends MessageToolArtifacts {
  /** Stable id for referencing messages (optional until migration runs) */
  id?: string;
  role: Role;
  content:
    | string
    | Array<TextMessageContent | FileMessageContent>
    | Array<TextMessageContent | ImageMessageContent>
    | Array<TextMessageContent | FileMessageContent | ImageMessageContent> // Support mixed content (images + files + text)
    | TextMessageContent
    | ExtractionResultContent;
  messageType: MessageType | ChatInputSubmitTypes | undefined;
  citations?: Citation[];
  thinking?: string;
  transcript?: TranscriptMetadata;
  error?: boolean; // Indicates if the message generation failed
  toneId?: string | null; // Custom tone/voice profile to apply
  promptId?: string | null; // Saved prompt that was used
  promptVariables?: { [key: string]: string }; // Variable values used in the prompt
  artifactContext?: {
    // Artifact being edited when message was sent
    fileName: string;
    language: string;
    code: string;
  };
  /** Pending batch transcription job ID (for async transcription >25MB files) */
  pendingTranscriptionJobId?: string;
  /** Filename being transcribed (for UI display during pending state) */
  pendingTranscriptionFilename?: string;
  /** Blob path for cleanup after transcription completes */
  pendingTranscriptionBlobPath?: string;
}

/**
 * The shape we persist on a message for a tool call. Identical to the wire
 * payload — aliased rather than re-declared so the two can't drift.
 */
export type ToolCallRecord = ToolCallRecordPayload;

/**
 * Tool/approval/consent artifacts attached to an assistant turn. Shared by
 * `Message` (legacy single-message) and `AssistantMessageVersion` (regenerated
 * versions) so the two stay in lockstep.
 */
export interface MessageToolArtifacts {
  /**
   * Outcomes for MCP tool-approval prompts that originated in this turn.
   * Keyed by `approval_request_id`; value is the user's decision (true=approve,
   * false=deny). Persisted so reloading the conversation doesn't show the card
   * in pending state again.
   */
  approvalOutcomes?: Record<string, boolean>;
  /**
   * How each approval was resolved. Parallel to `approvalOutcomes` and used by
   * the consent card to suppress display for auto-approved tools (those already
   * appear in the tool usage summary instead).
   */
  approvalSources?: Record<string, 'manual' | 'auto-approved' | 'auto-denied'>;
  /**
   * Persisted records of MCP tool calls that ran while generating this turn.
   * Renders as the collapsed "Used N tools" summary below the assistant text.
   */
  toolCalls?: ToolCallRecord[];
  /**
   * Persisted consent / OAuth prompts emitted during this turn. Saved so a turn
   * that contained only a consent card (no assistant text) still renders its
   * card after the stream finalizes and on conversation reload.
   */
  consentRequests?: ConsentRequest[];
  /**
   * Real token usage reported by the provider for the request that produced
   * this turn. Absent on turns from before usage tracking existed — those are
   * back-calculated from text for emissions estimates (see usageBackfill).
   */
  usage?: TokenUsageMetadata;
}

/**
 * Persisted shape of a consent / approval prompt. Flat (not discriminated)
 * so the existing ConsentCard prop shape can satisfy it directly.
 */
export interface ConsentRequest {
  kind: 'oauth' | 'approval';
  consent_url?: string;
  approval_request_id?: string;
  server_label?: string | null;
  /**
   * Native-MCP server id (McpServerConfig.id) for tool-loop approvals; the
   * client uses it to rebuild `mcpPendingToolCalls` on resume. Absent on
   * Foundry-agent approvals.
   */
  server_id?: string | null;
  tool_name?: string | null;
  tool_arguments?: string | null;
}

export type Role = 'system' | 'assistant' | 'user';

export type ChatInputSubmitTypes = 'TEXT' | 'IMAGE' | 'FILE' | 'MULTI_FILE';

/**
 * Represents a single assistant message version.
 * Used when the user regenerates responses - each regeneration creates a new version.
 */
export interface AssistantMessageVersion extends MessageToolArtifacts {
  content:
    | string
    | Array<TextMessageContent | FileMessageContent>
    | Array<TextMessageContent | ImageMessageContent>
    | Array<TextMessageContent | FileMessageContent | ImageMessageContent>
    | TextMessageContent
    | ExtractionResultContent;
  messageType: MessageType | ChatInputSubmitTypes | undefined;
  citations?: Citation[];
  thinking?: string;
  transcript?: TranscriptMetadata;
  error?: boolean;
  createdAt: string; // ISO timestamp for when this version was generated
}

/**
 * Groups multiple assistant response versions for a single user message.
 * The activeIndex determines which version is currently displayed.
 */
export interface AssistantMessageGroup {
  type: 'assistant_group';
  activeIndex: number;
  versions: AssistantMessageVersion[];
}

/**
 * Union type for conversation message entries.
 * Supports both legacy flat Message objects and new grouped assistant responses.
 */
export type ConversationEntry = Message | AssistantMessageGroup;

/**
 * Type guard to check if an entry is an AssistantMessageGroup.
 */
export function isAssistantMessageGroup(
  entry: ConversationEntry,
): entry is AssistantMessageGroup {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'type' in entry &&
    (entry as AssistantMessageGroup).type === 'assistant_group'
  );
}

/**
 * Type guard to check if an entry is a legacy Message (not a group).
 */
export function isLegacyMessage(entry: ConversationEntry): entry is Message {
  return !isAssistantMessageGroup(entry);
}

/**
 * Version info for display in the UI.
 */
export interface VersionInfo {
  current: number; // 1-indexed for display
  total: number;
  hasMultiple: boolean;
}

export interface ChatBody {
  model: OpenAIModel;
  messages: Message[];
  key: string;
  prompt: string;
  temperature: number;
  botId: string | undefined;
  stream?: boolean;
  threadId?: string; // Azure AI Agent thread ID
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; // For GPT-5 and o3 models
  verbosity?: 'low' | 'medium' | 'high'; // For GPT-5 models
  forcedAgentType?: string; // Force routing to specific agent type (e.g., 'web_search')
  /**
   * Which region's hosted instance this conversation chats with
   * (cross-region routing). Client preference only: the server forces EU
   * users to EU regardless (resolveChatRegion).
   */
  hostedRegion?: 'US' | 'EU';
  isEditorOpen?: boolean; // Indicates if code editor is currently open
  tone?: Tone; // Full tone object (if tone is selected)
  streamingSpeed?: StreamingSpeedConfig; // Smooth streaming speed configuration
  includeUserInfoInPrompt?: boolean; // Include user name/title/dept in system prompt
  preferredName?: string; // User's preferred name (overrides profile displayName)
  userContext?: string; // Additional user context for the AI
  displayNamePreference?: DisplayNamePreference; // For deriving name fallback
  customDisplayName?: string; // Custom display name from General Settings
  // Active files to include in context (optional)
  activeFiles?: ActiveFile[];
  activeFilesTokensUsed?: number; // Cumulative tokens consumed by active files
  /**
   * Whether pinned-image active files should be re-injected into this turn's
   * last user message. Defaults to `true` server-side if absent. See
   * `lib/services/chat/processors/ActiveFileInjector.ts` for the injection
   * branch and the AnthropicHandler caveat.
   */
  autoInjectPinnedImages?: boolean;
  /**
   * ARM resource path of the Foundry project that hosts the agent being
   * invoked. Disambiguates same-named agents across projects in the server
   * cache and scopes lazy discovery to a single ARM call on cache miss.
   * Server validates against `isValidFoundryResourcePath` before use; an
   * invalid or absent value falls back to the regional default.
   */
  agentSourcePath?: string;
  /**
   * ARM resource path of the user-added Foundry account a custom-source
   * (`byom-`) model belongs to. Same trust model as `agentSourcePath`: the
   * server re-validates the path, strips it to the account, and re-resolves
   * the deployment under the user's own ARM OBO token before any routing.
   */
  modelSourcePath?: string;
  /**
   * MCP tool-approval responses to submit alongside (or in lieu of) a new
   * user message. When this is non-empty the server skips creating a new
   * user-message conversation item and instead posts `mcp_approval_response`
   * items, then resumes the agent's response stream. See AIFoundryAgentHandler.
   */
  approvalResponses?: ApprovalResponse[];
  /**
   * MCP servers whose tools the model may call this turn (native MCP tool
   * loop in the direct SDK paths — NOT the Foundry agent path). Assembled
   * client-side from the Connectors settings. Curated entries carry a
   * catalogKey and the server ignores any client-sent url for them.
   */
  mcpServers?: import('./mcp').McpServerRequestEntry[];
  /**
   * Tool calls the model requested last round, echoed back with the user's
   * approvalResponses so the stateless server can reconstruct the transcript
   * and execute approved calls. Built from persisted consent requests.
   */
  mcpPendingToolCalls?: import('./mcp').McpPendingToolCall[];
  /** 0-based MCP tool-loop round counter; the server caps it (see loop). */
  mcpLoopRound?: number;
  /**
   * Structured data extraction payload. Up to 3 recipes; the chat pipeline
   * picks this up via `ExtractionEnricher` and issues a strict JSON-schema
   * call (`StandardChatHandler` honours `context.responseFormat`).
   */
  extraction?: ExtractionRequest;
  /**
   * Best-effort summary of earlier messages dropped by client-side context
   * windowing (conversation compaction). Rendered into the system prompt
   * server-side. Cap 8,000 chars (enforced in InputValidator).
   */
  conversationSummary?: string;
  /**
   * Long-term user memory snippets (Memories feature, LD-gated client-side).
   * Rendered into the system prompt server-side. Caps: 60 items x 600 chars
   * (enforced in InputValidator).
   */
  memories?: string[];
}

/**
 * One MCP tool-approval decision the user has submitted from the consent
 * card. The id is the `approval_request_id` Foundry surfaced when it
 * emitted the `mcp_approval_request` output item.
 */
export interface ApprovalResponse {
  approval_request_id: string;
  approve: boolean;
}

export interface Conversation {
  id: string;
  name: string;
  messages: ConversationEntry[];
  model: OpenAIModel;
  prompt: string;
  temperature: number;
  folderId: string | null;
  bot?: string;
  createdAt?: string;
  updatedAt?: string;
  threadId?: string; // Azure AI Agent thread ID
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'; // For GPT-5 and o3 models
  verbosity?: 'low' | 'medium' | 'high'; // For GPT-5 models
  defaultSearchMode?: import('./searchMode').SearchMode; // Default search mode for this conversation
  /**
   * Which region's hosted instance this conversation chats with. Set from
   * the details panel (US users, dually-hosted models) or implicitly when a
   * US user selects an EU-only model. EU users never carry a US value — the
   * server forces EU regardless.
   */
  hostedRegion?: 'US' | 'EU';
  // Active file context (optional; initialized via migration)
  activeFiles?: ActiveFile[];
  activeFilesTokenBudget?: number;
  activeFilesPriority?: 'recent' | 'pinned' | 'sizeAsc';
  activeFilesMaxCount?: number;
  activeFilesTokensUsed?: number; // cumulative tokens consumed, starts at 0
  /**
   * Tool names this conversation auto-approves on sight (no card prompt).
   * Set when the user picks "Always approve this tool" from a consent card.
   */
  alwaysApproveTools?: string[];
  /**
   * If true, every MCP tool-approval prompt in this conversation auto-approves
   * without surfacing a card. Set via "Always approve all tools".
   */
  alwaysApproveAllTools?: boolean;
  /**
   * True when `name` was produced by auto-titling rather than typed by the
   * user. Auto-namers may upgrade an auto-generated name (a truncation
   * being replaced by a written title, a workflow's first upload being
   * replaced by the document's own heading) but must never overwrite a name
   * the user chose. Absent is treated as user-set, so conversations named
   * before this field existed are left alone.
   */
  nameAutoGenerated?: boolean;
  /**
   * Workflow specialization. Absent = normal chat. Settable while the
   * conversation is still empty (WorkflowTabs lets the user switch modes);
   * the first message settles it, after which conversationStore strips
   * attempts to mutate it.
   */
  conversationType?: import('./workflow').ConversationWorkflowType;
  /**
   * Workflow-specific persisted state; its `kind` must match
   * `conversationType`. Write via conversationStore.updateWorkflowState only.
   */
  workflowState?: import('./workflow').WorkflowState;
  /**
   * Conversation compaction state. `summary` covers entries
   * `1..upToEntryIndex-1` (exclusive index; entry 0 is always sent verbatim).
   * Entry indices map 1:1 to flattened message indices.
   */
  compaction?: {
    summary: string;
    upToEntryIndex: number;
    updatedAt: string;
  };
}

export type FileFieldValue =
  | FileMessageContent
  | FileMessageContent[]
  | ImageMessageContent
  | ImageMessageContent[]
  | (FileMessageContent | ImageMessageContent)[]
  | null;

export type ImageFieldValue =
  | ImageMessageContent
  | ImageMessageContent[]
  | null;

/**
 * Status of a file during upload/processing workflow
 */
export type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'extracting' // Video: extracting audio before upload
  | 'completed'
  | 'failed';

/**
 * Status of async transcription jobs (batch API).
 * `cancelled` is distinct from `failed` so the UI can render a neutral tile
 * instead of the red "failed" state when the user aborted the job.
 */
export type TranscriptionJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FilePreview {
  name: string;
  type: string;
  status: UploadStatus;
  previewUrl: string;
  /**
   * Server-side URL set after a successful upload (e.g. `/api/file/{hash}.{ext}`).
   * Used by `removeFile` to match a preview against entries in `imageFieldValue`
   * — `previewUrl` is a `blob:` URL and never equals the server URL stored on
   * `ImageMessageContent.image_url.url`.
   */
  uploadedUrl?: string;
  file?: File; // Optional: Store the original File object for local operations (e.g., opening in code editor)
  // Transcription tracking for batch jobs
  transcriptionJobId?: string;
  transcriptionStatus?: TranscriptionJobStatus;
  // Transcription options (for audio/video files)
  transcriptionLanguage?: string; // ISO-639-1 code (e.g., 'en', 'es', 'fr'). Undefined = auto-detect
  transcriptionPrompt?: string; // Optional context/instructions for Whisper
  // Original video info (when audio was extracted)
  extractedFromVideo?: {
    originalName: string;
    originalSize: number;
    extractedSize: number;
  };
}

// Tool Router Types
export type ToolType = 'web_search';

export interface ToolRouterResponse {
  tools: ToolType[];
  searchQuery?: string;
  reasoning?: string; // Optional reasoning for debugging
}

export interface ToolRouterRequest {
  messages: Message[];
  currentMessage: string;
  forceWebSearch?: boolean; // When true, always use web search (search mode enabled)
}

// Persistent File Context types
export interface ActiveFile {
  id: string; // Unique identifier (e.g., hash of URL + originalFilename)
  url: string;
  originalFilename: string;
  addedAt: string; // ISO timestamp
  sourceMessageId: string; // Stable message id

  // Lifecycle & UX
  status: 'idle' | 'processing' | 'ready' | 'error';
  lastUsedAt?: string;
  errorMessage?: string;
  pinned?: boolean;

  // Cached processed content (populated after first use)
  processedContent?: {
    type: 'document' | 'transcript' | 'image';
    content: string; // Extracted text or transcript
    summary?: string; // Optional summarized content for large docs
    tokenEstimate: number;
    tokenEstimateEncoding?: string;
    processedAt: string; // ISO timestamp
  };

  // Metadata
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string; // Optional integrity/dedup signal
}
