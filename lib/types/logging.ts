/**
 * Azure Monitor Log Ingestion Type Definitions
 *
 * Types for structured business event logging to Azure Monitor.
 * These types mirror the schema used in the original MSF-USA/chatbot-ui repository
 * to ensure logging continuity and compatibility.
 */

/**
 * Supported log event types for categorization in Azure Monitor.
 */
export enum LogEventType {
  ChatCompletion = 'ChatCompletion',
  Error = 'Error',
  FileSuccess = 'FileSuccess',
  FileError = 'FileError',
  FileRetrievalSuccess = 'FileRetrievalSuccess',
  FileRetrievalError = 'FileRetrievalError',
  Search = 'Search',
  SearchError = 'SearchError',
  AgentExecution = 'AgentExecution',
  AgentError = 'AgentError',
  TranscriptionSuccess = 'TranscriptionSuccess',
  TranscriptionError = 'TranscriptionError',
  TranscriptionQueued = 'TranscriptionQueued',
  TTSSuccess = 'TTSSuccess',
  TTSError = 'TTSError',
  TranslationSuccess = 'TranslationSuccess',
  TranslationError = 'TranslationError',
  DocumentExportSuccess = 'DocumentExportSuccess',
  DocumentExportError = 'DocumentExportError',
  ToneAnalysisSuccess = 'ToneAnalysisSuccess',
  ToneAnalysisError = 'ToneAnalysisError',
  TokenUsage = 'TokenUsage',
  CustomMetric = 'CustomMetric',
}

/**
 * Error severity levels for error log entries.
 */
export enum ErrorSeverity {
  Info = 'Info',
  Warning = 'Warning',
  Error = 'Error',
  Critical = 'Critical',
}

/**
 * Base fields common to all log entries.
 * These fields provide context for every logged event.
 */
export interface BaseLogEntry {
  /** ISO 8601 timestamp of when the event occurred */
  Timestamp: string;
  /** Type of event being logged */
  EventType: LogEventType;
  /** Unique identifier for the user */
  UserId: string;
  /** User's email address */
  UserEmail: string;
  /** User's first/given name */
  UserGivenName?: string;
  /** User's last/surname */
  UserSurName?: string;
  /** User's display name */
  UserDisplayName?: string;
  /** User's job title */
  UserJobTitle?: string;
  /** User's department */
  UserDepartment?: string;
  /** User's company/organization name */
  UserCompanyName?: string;
  /** Bot/assistant identifier if applicable */
  BotId?: string;
  /** Environment (localhost, dev, staging, beta, prod) */
  Env: string;
  /** Duration of the operation in milliseconds */
  Duration?: number;
  /** Agent identifier for AI Foundry agents */
  AgentId?: string;
  /** Agent type (e.g., 'bing_grounding', 'custom') */
  AgentType?: string;
  /** Model used for the operation */
  ModelUsed?: string;
  /** Number of messages in the conversation context */
  MessageCount?: number;
  /** Temperature setting for the model */
  Temperature?: number;
  /** Request correlation ID for distributed tracing */
  CorrelationId?: string;
  /** Unique request identifier */
  RequestId?: string;
}

/**
 * Chat completion event log entry.
 * Logged when a chat completion request is successfully processed.
 */
export interface ChatCompletionLogEntry extends BaseLogEntry {
  EventType: LogEventType.ChatCompletion;
  /** Whether files were included in the request */
  HasFiles: boolean;
  /** Whether images were included in the request */
  HasImages: boolean;
  /** Whether RAG (knowledge base) was used */
  HasRAG: boolean;
  /** Number of prompt tokens used */
  PromptTokens?: number;
  /** Number of completion tokens generated */
  CompletionTokens?: number;
  /** Total tokens used */
  TotalTokens?: number;
  /** Reasoning effort level (for reasoning models) */
  ReasoningEffort?: string;
}

/**
 * Token usage event — the authoritative per-request record of real provider
 * token counts, logged at stream end (or inline for non-streaming). Carries
 * the emissions estimate computed with the assumption set identified by
 * AssumptionsVersion (config/emissions.json), so estimates in the logs are
 * traceable and re-computable when assumptions change.
 */
export interface TokenUsageLogEntry extends BaseLogEntry {
  EventType: LogEventType.TokenUsage;
  /** Model that ACTUALLY served the request (fallback chain may switch). */
  Model: string;
  /** Resolved chat region ('US' | 'EU'); 'default' when home clients served. */
  Region: string;
  PromptTokens: number;
  CompletionTokens: number;
  TotalTokens: number;
  /** Reasoning effort applied to the request, if any. */
  ReasoningEffort?: string;
  /** Emissions size class of the serving model (nano/mini/standard/large). */
  SizeClass: string;
  EstimatedCO2Grams: number;
  EstimatedEnergyWh: number;
  /** Version of the assumption set that produced the estimate. */
  AssumptionsVersion: string;
  /** Whether the response was streamed. */
  Streamed: boolean;
  /** Bot/knowledge base ID when RAG was involved. */
  BotId?: string;
}

/**
 * Error event log entry.
 * Logged when an error occurs during any operation.
 */
export interface ErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.Error;
  /** Error code for categorization */
  ErrorCode: string;
  /** Human-readable error message */
  ErrorMessage: string;
  /** Stack trace (sanitized) */
  StackTrace?: string;
  /** Error severity level */
  Severity: ErrorSeverity;
  /** Operation that was being performed when the error occurred */
  Operation?: string;
}

/**
 * File upload success log entry.
 */
export interface FileSuccessLogEntry extends BaseLogEntry {
  EventType: LogEventType.FileSuccess;
  /** Original filename */
  Filename: string;
  /** File size in bytes */
  FileSize: number;
  /** MIME type or file type category */
  FileType: string;
  /** Number of chunks if file was chunked */
  ChunkCount?: number;
}

/**
 * File upload/processing error log entry.
 */
export interface FileErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.FileError;
  /** Original filename */
  Filename: string;
  /** File size in bytes */
  FileSize?: number;
  /** MIME type or file type category */
  FileType?: string;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Search (RAG) success log entry.
 */
export interface SearchLogEntry extends BaseLogEntry {
  EventType: LogEventType.Search;
  /** Search query text */
  Query: string;
  /** Number of results returned */
  ResultCount: number;
  /** Type of search (e.g., 'semantic', 'hybrid', 'keyword') */
  SearchType?: string;
  /** Name of the search index used */
  IndexName?: string;
}

/**
 * Search error log entry.
 */
export interface SearchErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.SearchError;
  /** Search query text */
  Query?: string;
  /** Name of the search index used */
  IndexName?: string;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Agent execution success log entry.
 */
export interface AgentExecutionLogEntry extends BaseLogEntry {
  EventType: LogEventType.AgentExecution;
  /** Agent identifier */
  AgentId: string;
  /** Type of agent */
  AgentType: string;
  /** Thread identifier for conversation continuity */
  ThreadId?: string;
  /** List of tools used during execution */
  ToolsUsed?: string[];
  /** Number of turns/steps in the agent execution */
  TurnCount?: number;
}

/**
 * Agent execution error log entry.
 */
export interface AgentErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.AgentError;
  /** Agent identifier */
  AgentId?: string;
  /** Type of agent */
  AgentType?: string;
  /** Thread identifier */
  ThreadId?: string;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Transcription success log entry.
 */
export interface TranscriptionSuccessLogEntry extends BaseLogEntry {
  EventType: LogEventType.TranscriptionSuccess;
  /** Original filename */
  Filename: string;
  /** File size in bytes */
  FileSize: number;
  /** Type of transcription (e.g., 'whisper', 'batch', 'chunked') */
  TranscriptionType: string;
  /** Duration of the audio in seconds */
  AudioDuration?: number;
  /** Language detected or specified */
  Language?: string;
}

/**
 * Transcription error log entry.
 */
export interface TranscriptionErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.TranscriptionError;
  /** Original filename */
  Filename?: string;
  /** File size in bytes */
  FileSize?: number;
  /** Type of transcription attempted */
  TranscriptionType?: string;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Transcription queued log entry.
 * Logged when a chunked transcription job is submitted for async processing.
 */
export interface TranscriptionQueuedLogEntry extends BaseLogEntry {
  EventType: LogEventType.TranscriptionQueued;
  /** Original filename */
  Filename: string;
  /** File size in bytes */
  FileSize: number;
  /** Job ID for tracking */
  JobId: string;
  /** Number of chunks to process */
  TotalChunks: number;
  /** Language detected or specified */
  Language?: string;
}

/**
 * Custom metric log entry for ad-hoc measurements.
 */
export interface CustomMetricLogEntry extends BaseLogEntry {
  EventType: LogEventType.CustomMetric;
  /** Name of the metric */
  MetricName: string;
  /** Numeric value of the metric */
  MetricValue: number;
  /** Unit of measurement */
  MetricUnit?: string;
  /** Additional tags for categorization */
  Tags?: Record<string, string>;
}

/**
 * TTS (Text-to-Speech) success log entry.
 */
export interface TTSSuccessLogEntry extends BaseLogEntry {
  EventType: LogEventType.TTSSuccess;
  /** Length of the input text in characters */
  TextLength: number;
  /** Target language code for synthesis */
  TargetLanguage: string;
  /** Name of the voice used for synthesis */
  VoiceName: string;
  /** Audio output format */
  AudioFormat?: string;
}

/**
 * TTS (Text-to-Speech) error log entry.
 */
export interface TTSErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.TTSError;
  /** Length of the input text in characters */
  TextLength?: number;
  /** Target language code for synthesis */
  TargetLanguage?: string;
  /** Name of the voice used for synthesis */
  VoiceName?: string;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Translation success log entry.
 */
export interface TranslationSuccessLogEntry extends BaseLogEntry {
  EventType: LogEventType.TranslationSuccess;
  /** Source language code (if detected/specified) */
  SourceLanguage?: string;
  /** Target language code */
  TargetLanguage: string;
  /** Length of the content being translated */
  ContentLength: number;
  /** Whether this is a document translation (vs. text) */
  IsDocumentTranslation: boolean;
}

/**
 * Translation error log entry.
 */
export interface TranslationErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.TranslationError;
  /** Source language code (if detected/specified) */
  SourceLanguage?: string;
  /** Target language code */
  TargetLanguage?: string;
  /** Length of the content being translated */
  ContentLength?: number;
  /** Whether this is a document translation (vs. text) */
  IsDocumentTranslation: boolean;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Document export success log entry.
 */
export interface DocumentExportSuccessLogEntry extends BaseLogEntry {
  EventType: LogEventType.DocumentExportSuccess;
  /** Export format */
  Format: 'docx' | 'pdf';
  /** Length of the content in characters */
  ContentLength: number;
  /** Number of messages if exporting a conversation */
  MessageCount?: number;
}

/**
 * Document export error log entry.
 */
export interface DocumentExportErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.DocumentExportError;
  /** Export format */
  Format?: 'docx' | 'pdf';
  /** Length of the content in characters */
  ContentLength?: number;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Tone analysis success log entry.
 */
export interface ToneAnalysisSuccessLogEntry extends BaseLogEntry {
  EventType: LogEventType.ToneAnalysisSuccess;
  /** Length of the input content in characters */
  InputLength: number;
  /** Name of the detected/analyzed tone */
  ToneName: string;
  /** Number of tags detected */
  TagCount?: number;
}

/**
 * Tone analysis error log entry.
 */
export interface ToneAnalysisErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.ToneAnalysisError;
  /** Length of the input content in characters */
  InputLength?: number;
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * File retrieval success log entry.
 */
export interface FileRetrievalSuccessLogEntry extends BaseLogEntry {
  EventType: LogEventType.FileRetrievalSuccess;
  /** File identifier (SHA256 hash, optionally with file extension e.g., "abc123.pdf") */
  FileId: string;
  /** Type of file (image or file) */
  FileType: 'image' | 'file';
}

/**
 * File retrieval error log entry.
 */
export interface FileRetrievalErrorLogEntry extends BaseLogEntry {
  EventType: LogEventType.FileRetrievalError;
  /** File identifier (SHA256 hash, optionally with file extension e.g., "abc123.pdf") */
  FileId?: string;
  /** Type of file (image or file) */
  FileType?: 'image' | 'file';
  /** Error code */
  ErrorCode: string;
  /** Error message */
  ErrorMessage: string;
}

/**
 * Union type of all log entry types.
 */
export type LogEntry =
  | ChatCompletionLogEntry
  | TokenUsageLogEntry
  | ErrorLogEntry
  | FileSuccessLogEntry
  | FileErrorLogEntry
  | FileRetrievalSuccessLogEntry
  | FileRetrievalErrorLogEntry
  | SearchLogEntry
  | SearchErrorLogEntry
  | AgentExecutionLogEntry
  | AgentErrorLogEntry
  | TranscriptionSuccessLogEntry
  | TranscriptionErrorLogEntry
  | TranscriptionQueuedLogEntry
  | TTSSuccessLogEntry
  | TTSErrorLogEntry
  | TranslationSuccessLogEntry
  | TranslationErrorLogEntry
  | DocumentExportSuccessLogEntry
  | DocumentExportErrorLogEntry
  | ToneAnalysisSuccessLogEntry
  | ToneAnalysisErrorLogEntry
  | CustomMetricLogEntry;

/**
 * User context for logging, extracted from session.
 */
export interface LoggingUserContext {
  id: string;
  email: string;
  givenName?: string;
  surName?: string;
  displayName?: string;
  jobTitle?: string;
  department?: string;
  companyName?: string;
}
