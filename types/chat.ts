import { TranscriptMetadata } from '@/lib/utils/app/metadata';

import { OpenAIModel } from './openai';
import { Citation } from './rag';
import { DisplayNamePreference, StreamingSpeedConfig } from './settings';
import { Tone } from './tone';

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

export interface Message {
  /** Stable id for referencing messages (optional until migration runs) */
  id?: string;
  role: Role;
  content:
    | string
    | Array<TextMessageContent | FileMessageContent>
    | Array<TextMessageContent | ImageMessageContent>
    | Array<TextMessageContent | FileMessageContent | ImageMessageContent> // Support mixed content (images + files + text)
    | TextMessageContent;
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

export type Role = 'system' | 'assistant' | 'user';

export type ChatInputSubmitTypes = 'TEXT' | 'IMAGE' | 'FILE' | 'MULTI_FILE';

/**
 * Represents a single assistant message version.
 * Used when the user regenerates responses - each regeneration creates a new version.
 */
export interface AssistantMessageVersion {
  content:
    | string
    | Array<TextMessageContent | FileMessageContent>
    | Array<TextMessageContent | ImageMessageContent>
    | Array<TextMessageContent | FileMessageContent | ImageMessageContent>
    | TextMessageContent;
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
  isEditorOpen?: boolean; // Indicates if code editor is currently open
  tone?: Tone; // Full tone object (if tone is selected)
  streamingSpeed?: StreamingSpeedConfig; // Smooth streaming speed configuration
  includeUserInfoInPrompt?: boolean; // Include user name/title/dept in system prompt
  preferredName?: string; // User's preferred name (overrides profile displayName)
  userContext?: string; // Additional user context for the AI
  displayNamePreference?: DisplayNamePreference; // For deriving name fallback
  customDisplayName?: string; // Custom display name from General Settings
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
  // Active file context (optional; initialized via migration)
  activeFiles?: ActiveFile[];
  activeFilesTokenBudget?: number;
  activeFilesPriority?: 'recent' | 'pinned' | 'sizeAsc';
  activeFilesMaxCount?: number;
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
 * Status of async transcription jobs (batch API)
 */
export type TranscriptionJobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

export interface FilePreview {
  name: string;
  type: string;
  status: UploadStatus;
  previewUrl: string;
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
