/**
 * Azure Monitor Logging Service
 *
 * Singleton service for ingesting structured business events to Azure Monitor Logs.
 * Uses the Azure Monitor Ingestion SDK with DefaultAzureCredential for authentication.
 *
 * Features:
 * - Graceful degradation: Falls back to console logging when Azure is unavailable
 * - Fire-and-forget: Default async pattern to avoid latency impact
 * - Sanitization: Uses existing sanitizeForLog utility
 * - Singleton pattern: Ensures single client instance
 *
 * @see https://learn.microsoft.com/en-us/azure/azure-monitor/logs/logs-ingestion-api-overview
 */
import { Session } from 'next-auth';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import {
  AgentErrorLogEntry,
  AgentExecutionLogEntry,
  BaseLogEntry,
  ChatCompletionLogEntry,
  CustomMetricLogEntry,
  DocumentExportErrorLogEntry,
  DocumentExportSuccessLogEntry,
  ErrorLogEntry,
  ErrorSeverity,
  FileErrorLogEntry,
  FileRetrievalErrorLogEntry,
  FileRetrievalSuccessLogEntry,
  FileSuccessLogEntry,
  LogEntry,
  LogEventType,
  LoggingUserContext,
  SearchErrorLogEntry,
  SearchLogEntry,
  TTSErrorLogEntry,
  TTSSuccessLogEntry,
  TokenUsageLogEntry,
  ToneAnalysisErrorLogEntry,
  ToneAnalysisSuccessLogEntry,
  TranscriptionErrorLogEntry,
  TranscriptionQueuedLogEntry,
  TranscriptionSuccessLogEntry,
  TranslationErrorLogEntry,
  TranslationSuccessLogEntry,
} from '@/lib/types/logging';

import { env } from '@/config/environment';
import { DefaultAzureCredential } from '@azure/identity';
import { LogsIngestionClient } from '@azure/monitor-ingestion';

/**
 * Azure Monitor Logging Service singleton.
 * Provides structured logging to Azure Monitor Logs via the Data Collection Rule endpoint.
 */
export class AzureMonitorLoggingService {
  private static instance: AzureMonitorLoggingService | null = null;
  private client: LogsIngestionClient | null = null;
  private readonly endpoint: string | undefined;
  private readonly ruleId: string | undefined;
  private readonly streamName: string;
  private readonly environment: string;
  private readonly isEnabled: boolean;

  private constructor() {
    this.endpoint = env.LOGS_INJESTION_ENDPOINT;
    this.ruleId = env.DATA_COLLECTION_RULE_ID;
    this.streamName = env.STREAM_NAME || 'Custom-ChatBotLogs_CL';
    this.environment = env.NEXT_PUBLIC_ENV || 'localhost';

    // Enable only if both endpoint and rule ID are configured
    this.isEnabled = !!(this.endpoint && this.ruleId);

    if (this.isEnabled) {
      try {
        const credential = new DefaultAzureCredential();
        this.client = new LogsIngestionClient(this.endpoint!, credential);
        console.log(
          '[AzureMonitorLoggingService] Initialized with endpoint:',
          sanitizeForLog(this.endpoint),
        );
      } catch (error) {
        console.warn(
          '[AzureMonitorLoggingService] Failed to initialize client:',
          sanitizeForLog(error),
        );
        this.client = null;
      }
    } else {
      console.log(
        '[AzureMonitorLoggingService] Disabled - missing LOGS_INJESTION_ENDPOINT or DATA_COLLECTION_RULE_ID',
      );
    }
  }

  /**
   * Gets the singleton instance of the logging service.
   */
  static getInstance(): AzureMonitorLoggingService {
    if (!AzureMonitorLoggingService.instance) {
      AzureMonitorLoggingService.instance = new AzureMonitorLoggingService();
    }
    return AzureMonitorLoggingService.instance;
  }

  /**
   * Resets the singleton instance. Used for testing.
   */
  static resetInstance(): void {
    AzureMonitorLoggingService.instance = null;
  }

  /**
   * Extracts user context from a NextAuth session.
   *
   * @param user - The user object from session
   * @returns Normalized user context for logging
   */
  private extractUserContext(user: Session['user']): LoggingUserContext {
    return {
      id: user.id || 'unknown',
      email: user.mail || 'unknown',
      givenName: user.givenName,
      surName: user.surname,
      displayName: user.displayName,
      jobTitle: user.jobTitle,
      department: user.department,
      companyName: user.companyName,
    };
  }

  /**
   * Creates base log entry fields common to all events.
   *
   * @param eventType - The type of event
   * @param user - User context from session
   * @param options - Additional optional fields
   */
  private createBaseEntry(
    eventType: LogEventType,
    user: LoggingUserContext,
    options?: {
      botId?: string;
      agentId?: string;
      agentType?: string;
      modelUsed?: string;
      messageCount?: number;
      temperature?: number;
      duration?: number;
      correlationId?: string;
      requestId?: string;
    },
  ): BaseLogEntry {
    return {
      Timestamp: new Date().toISOString(),
      EventType: eventType,
      UserId: user.id,
      UserEmail: user.email,
      UserGivenName: user.givenName,
      UserSurName: user.surName,
      UserDisplayName: user.displayName,
      UserJobTitle: user.jobTitle,
      UserDepartment: user.department,
      UserCompanyName: user.companyName,
      BotId: options?.botId,
      Env: this.environment,
      Duration: options?.duration,
      AgentId: options?.agentId,
      AgentType: options?.agentType,
      ModelUsed: options?.modelUsed,
      MessageCount: options?.messageCount,
      Temperature: options?.temperature,
      CorrelationId: options?.correlationId,
      RequestId: options?.requestId,
    };
  }

  /**
   * Uploads log entries to Azure Monitor.
   * Falls back to console logging if Azure is unavailable.
   *
   * @param entries - Array of log entries to upload
   * @param shouldAwait - If true, waits for the upload to complete
   */
  private async uploadLogs(
    entries: LogEntry[],
    shouldAwait: boolean = false,
  ): Promise<void> {
    if (!this.isEnabled || !this.client) {
      // Fallback to console logging
      for (const entry of entries) {
        console.log(
          `[AzureMonitorLog] ${entry.EventType}:`,
          JSON.stringify(entry),
        );
      }
      return;
    }

    const uploadPromise = (async () => {
      try {
        // Cast entries to the expected Azure SDK type
        await this.client!.upload(
          this.ruleId!,
          this.streamName,
          entries as unknown as Record<string, unknown>[],
        );
      } catch (error) {
        console.error(
          '[AzureMonitorLoggingService] Failed to upload logs:',
          sanitizeForLog(error),
        );
        // Fallback to console on error
        for (const entry of entries) {
          console.log(
            `[AzureMonitorLog:Fallback] ${entry.EventType}:`,
            JSON.stringify(entry),
          );
        }
      }
    })();

    if (shouldAwait) {
      await uploadPromise;
    }
  }

  /**
   * Logs a successful chat completion event.
   *
   * @param params - Chat completion parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logChatCompletion(
    params: {
      user: Session['user'];
      model: string;
      messageCount: number;
      temperature?: number;
      duration: number;
      hasFiles: boolean;
      hasImages: boolean;
      hasRAG: boolean;
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      botId?: string;
      reasoningEffort?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: ChatCompletionLogEntry = {
      ...this.createBaseEntry(LogEventType.ChatCompletion, userContext, {
        modelUsed: params.model,
        messageCount: params.messageCount,
        temperature: params.temperature,
        duration: params.duration,
        botId: params.botId,
      }),
      EventType: LogEventType.ChatCompletion,
      HasFiles: params.hasFiles,
      HasImages: params.hasImages,
      HasRAG: params.hasRAG,
      PromptTokens: params.promptTokens,
      CompletionTokens: params.completionTokens,
      TotalTokens: params.totalTokens,
      ReasoningEffort: params.reasoningEffort,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs the authoritative per-request token usage + emissions estimate.
   * Fired at stream end (streamed) or inline (non-streaming). Fire-and-forget
   * by default so it never delays the response path.
   *
   * @param params - Token usage parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTokenUsage(
    params: {
      user: Session['user'];
      model: string;
      region: 'US' | 'EU' | null;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      reasoningEffort?: string;
      sizeClass: string;
      estimatedCO2Grams: number;
      estimatedEnergyWh: number;
      assumptionsVersion: string;
      streamed: boolean;
      botId?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TokenUsageLogEntry = {
      ...this.createBaseEntry(LogEventType.TokenUsage, userContext, {
        modelUsed: params.model,
        botId: params.botId,
      }),
      EventType: LogEventType.TokenUsage,
      Model: params.model,
      Region: params.region ?? 'default',
      PromptTokens: params.promptTokens,
      CompletionTokens: params.completionTokens,
      TotalTokens: params.totalTokens,
      ReasoningEffort: params.reasoningEffort,
      SizeClass: params.sizeClass,
      EstimatedCO2Grams: params.estimatedCO2Grams,
      EstimatedEnergyWh: params.estimatedEnergyWh,
      AssumptionsVersion: params.assumptionsVersion,
      Streamed: params.streamed,
      BotId: params.botId,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs an error event.
   *
   * @param params - Error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logError(
    params: {
      user?: Session['user'];
      errorCode: string;
      errorMessage: string;
      stackTrace?: string;
      severity?: ErrorSeverity;
      operation?: string;
      model?: string;
      botId?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = params.user
      ? this.extractUserContext(params.user)
      : { id: 'unknown', email: 'unknown' };

    const entry: ErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.Error, userContext, {
        modelUsed: params.model,
        botId: params.botId,
      }),
      EventType: LogEventType.Error,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
      StackTrace: params.stackTrace
        ? sanitizeForLog(params.stackTrace)
        : undefined,
      Severity: params.severity || ErrorSeverity.Error,
      Operation: params.operation,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful file upload event.
   *
   * @param params - File success parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logFileSuccess(
    params: {
      user: Session['user'];
      filename: string;
      fileSize: number;
      fileType: string;
      chunkCount?: number;
      duration?: number;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: FileSuccessLogEntry = {
      ...this.createBaseEntry(LogEventType.FileSuccess, userContext, {
        duration: params.duration,
      }),
      EventType: LogEventType.FileSuccess,
      Filename: sanitizeForLog(params.filename),
      FileSize: params.fileSize,
      FileType: params.fileType,
      ChunkCount: params.chunkCount,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a file upload/processing error event.
   *
   * @param params - File error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logFileError(
    params: {
      user: Session['user'];
      filename: string;
      fileSize?: number;
      fileType?: string;
      errorCode: string;
      errorMessage: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: FileErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.FileError, userContext),
      EventType: LogEventType.FileError,
      Filename: sanitizeForLog(params.filename),
      FileSize: params.fileSize,
      FileType: params.fileType,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful search (RAG) event.
   *
   * @param params - Search parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logSearch(
    params: {
      user: Session['user'];
      query: string;
      resultCount: number;
      searchType?: string;
      indexName?: string;
      duration?: number;
      botId?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: SearchLogEntry = {
      ...this.createBaseEntry(LogEventType.Search, userContext, {
        duration: params.duration,
        botId: params.botId,
      }),
      EventType: LogEventType.Search,
      Query: sanitizeForLog(params.query.slice(0, 500)), // Truncate long queries
      ResultCount: params.resultCount,
      SearchType: params.searchType,
      IndexName: params.indexName,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a search error event.
   *
   * @param params - Search error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logSearchError(
    params: {
      user: Session['user'];
      query?: string;
      indexName?: string;
      errorCode: string;
      errorMessage: string;
      botId?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: SearchErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.SearchError, userContext, {
        botId: params.botId,
      }),
      EventType: LogEventType.SearchError,
      Query: params.query
        ? sanitizeForLog(params.query.slice(0, 500))
        : undefined,
      IndexName: params.indexName,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful agent execution event.
   *
   * @param params - Agent execution parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logAgentExecution(
    params: {
      user: Session['user'];
      agentId: string;
      agentType: string;
      threadId?: string;
      toolsUsed?: string[];
      turnCount?: number;
      duration?: number;
      model?: string;
      botId?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: AgentExecutionLogEntry = {
      ...this.createBaseEntry(LogEventType.AgentExecution, userContext, {
        agentId: params.agentId,
        agentType: params.agentType,
        modelUsed: params.model,
        duration: params.duration,
        botId: params.botId,
      }),
      EventType: LogEventType.AgentExecution,
      AgentId: params.agentId,
      AgentType: params.agentType,
      ThreadId: params.threadId,
      ToolsUsed: params.toolsUsed,
      TurnCount: params.turnCount,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs an agent execution error event.
   *
   * @param params - Agent error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logAgentError(
    params: {
      user: Session['user'];
      agentId?: string;
      agentType?: string;
      threadId?: string;
      errorCode: string;
      errorMessage: string;
      model?: string;
      botId?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: AgentErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.AgentError, userContext, {
        agentId: params.agentId,
        agentType: params.agentType,
        modelUsed: params.model,
        botId: params.botId,
      }),
      EventType: LogEventType.AgentError,
      AgentId: params.agentId,
      AgentType: params.agentType,
      ThreadId: params.threadId,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful transcription event.
   *
   * @param params - Transcription success parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTranscriptionSuccess(
    params: {
      user: Session['user'];
      filename: string;
      fileSize: number;
      transcriptionType: string;
      audioDuration?: number;
      language?: string;
      duration?: number;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TranscriptionSuccessLogEntry = {
      ...this.createBaseEntry(LogEventType.TranscriptionSuccess, userContext, {
        duration: params.duration,
      }),
      EventType: LogEventType.TranscriptionSuccess,
      Filename: sanitizeForLog(params.filename),
      FileSize: params.fileSize,
      TranscriptionType: params.transcriptionType,
      AudioDuration: params.audioDuration,
      Language: params.language,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a transcription error event.
   *
   * @param params - Transcription error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTranscriptionError(
    params: {
      user: Session['user'];
      filename?: string;
      fileSize?: number;
      transcriptionType?: string;
      errorCode: string;
      errorMessage: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TranscriptionErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.TranscriptionError, userContext),
      EventType: LogEventType.TranscriptionError,
      Filename: params.filename ? sanitizeForLog(params.filename) : undefined,
      FileSize: params.fileSize,
      TranscriptionType: params.transcriptionType,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a transcription queued event.
   * Used when a chunked transcription job is submitted for async processing.
   *
   * @param params - Transcription queued parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTranscriptionQueued(
    params: {
      user: Session['user'];
      filename: string;
      fileSize: number;
      jobId: string;
      totalChunks: number;
      language?: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TranscriptionQueuedLogEntry = {
      ...this.createBaseEntry(LogEventType.TranscriptionQueued, userContext),
      EventType: LogEventType.TranscriptionQueued,
      Filename: sanitizeForLog(params.filename),
      FileSize: params.fileSize,
      JobId: params.jobId,
      TotalChunks: params.totalChunks,
      Language: params.language,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a custom metric event.
   *
   * @param params - Custom metric parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logCustomMetric(
    params: {
      user: Session['user'];
      metricName: string;
      metricValue: number;
      metricUnit?: string;
      tags?: Record<string, string>;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: CustomMetricLogEntry = {
      ...this.createBaseEntry(LogEventType.CustomMetric, userContext),
      EventType: LogEventType.CustomMetric,
      MetricName: params.metricName,
      MetricValue: params.metricValue,
      MetricUnit: params.metricUnit,
      Tags: params.tags,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful TTS (Text-to-Speech) event.
   *
   * @param params - TTS success parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTTSSuccess(
    params: {
      user: Session['user'];
      textLength: number;
      targetLanguage: string;
      voiceName: string;
      audioFormat?: string;
      duration?: number;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TTSSuccessLogEntry = {
      ...this.createBaseEntry(LogEventType.TTSSuccess, userContext, {
        duration: params.duration,
      }),
      EventType: LogEventType.TTSSuccess,
      TextLength: params.textLength,
      TargetLanguage: params.targetLanguage,
      VoiceName: params.voiceName,
      AudioFormat: params.audioFormat,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a TTS (Text-to-Speech) error event.
   *
   * @param params - TTS error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTTSError(
    params: {
      user: Session['user'];
      textLength?: number;
      targetLanguage?: string;
      voiceName?: string;
      errorCode: string;
      errorMessage: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TTSErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.TTSError, userContext),
      EventType: LogEventType.TTSError,
      TextLength: params.textLength,
      TargetLanguage: params.targetLanguage,
      VoiceName: params.voiceName,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful translation event.
   *
   * @param params - Translation success parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTranslationSuccess(
    params: {
      user: Session['user'];
      sourceLanguage?: string;
      targetLanguage: string;
      contentLength: number;
      isDocumentTranslation: boolean;
      duration?: number;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TranslationSuccessLogEntry = {
      ...this.createBaseEntry(LogEventType.TranslationSuccess, userContext, {
        duration: params.duration,
      }),
      EventType: LogEventType.TranslationSuccess,
      SourceLanguage: params.sourceLanguage,
      TargetLanguage: params.targetLanguage,
      ContentLength: params.contentLength,
      IsDocumentTranslation: params.isDocumentTranslation,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a translation error event.
   *
   * @param params - Translation error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logTranslationError(
    params: {
      user: Session['user'];
      sourceLanguage?: string;
      targetLanguage?: string;
      contentLength?: number;
      isDocumentTranslation: boolean;
      errorCode: string;
      errorMessage: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: TranslationErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.TranslationError, userContext),
      EventType: LogEventType.TranslationError,
      SourceLanguage: params.sourceLanguage,
      TargetLanguage: params.targetLanguage,
      ContentLength: params.contentLength,
      IsDocumentTranslation: params.isDocumentTranslation,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful document export event.
   *
   * @param params - Document export success parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logDocumentExportSuccess(
    params: {
      user: Session['user'];
      format: 'docx' | 'pdf';
      contentLength: number;
      messageCount?: number;
      duration?: number;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: DocumentExportSuccessLogEntry = {
      ...this.createBaseEntry(LogEventType.DocumentExportSuccess, userContext, {
        duration: params.duration,
      }),
      EventType: LogEventType.DocumentExportSuccess,
      Format: params.format,
      ContentLength: params.contentLength,
      MessageCount: params.messageCount,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a document export error event.
   *
   * @param params - Document export error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logDocumentExportError(
    params: {
      user: Session['user'];
      format?: 'docx' | 'pdf';
      contentLength?: number;
      errorCode: string;
      errorMessage: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: DocumentExportErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.DocumentExportError, userContext),
      EventType: LogEventType.DocumentExportError,
      Format: params.format,
      ContentLength: params.contentLength,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful tone analysis event.
   *
   * @param params - Tone analysis success parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logToneAnalysisSuccess(
    params: {
      user: Session['user'];
      inputLength: number;
      toneName: string;
      tagCount?: number;
      duration?: number;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: ToneAnalysisSuccessLogEntry = {
      ...this.createBaseEntry(LogEventType.ToneAnalysisSuccess, userContext, {
        duration: params.duration,
      }),
      EventType: LogEventType.ToneAnalysisSuccess,
      InputLength: params.inputLength,
      ToneName: params.toneName,
      TagCount: params.tagCount,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a tone analysis error event.
   *
   * @param params - Tone analysis error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logToneAnalysisError(
    params: {
      user: Session['user'];
      inputLength?: number;
      errorCode: string;
      errorMessage: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: ToneAnalysisErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.ToneAnalysisError, userContext),
      EventType: LogEventType.ToneAnalysisError,
      InputLength: params.inputLength,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a successful file retrieval event.
   *
   * @param params - File retrieval success parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logFileRetrievalSuccess(
    params: {
      user: Session['user'];
      fileId: string;
      fileType: 'image' | 'file';
      duration?: number;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: FileRetrievalSuccessLogEntry = {
      ...this.createBaseEntry(LogEventType.FileRetrievalSuccess, userContext, {
        duration: params.duration,
      }),
      EventType: LogEventType.FileRetrievalSuccess,
      FileId: sanitizeForLog(params.fileId),
      FileType: params.fileType,
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a file retrieval error event.
   *
   * @param params - File retrieval error parameters
   * @param shouldAwait - If true, waits for the log to be uploaded
   */
  async logFileRetrievalError(
    params: {
      user: Session['user'];
      fileId?: string;
      fileType?: 'image' | 'file';
      errorCode: string;
      errorMessage: string;
    },
    shouldAwait: boolean = false,
  ): Promise<void> {
    const userContext = this.extractUserContext(params.user);
    const entry: FileRetrievalErrorLogEntry = {
      ...this.createBaseEntry(LogEventType.FileRetrievalError, userContext),
      EventType: LogEventType.FileRetrievalError,
      FileId: params.fileId ? sanitizeForLog(params.fileId) : undefined,
      FileType: params.fileType,
      ErrorCode: params.errorCode,
      ErrorMessage: sanitizeForLog(params.errorMessage),
    };

    await this.uploadLogs([entry], shouldAwait);
  }

  /**
   * Logs a batch of entries at once.
   *
   * @param entries - Array of log entries
   * @param shouldAwait - If true, waits for the upload to complete
   */
  async logBatch(
    entries: LogEntry[],
    shouldAwait: boolean = false,
  ): Promise<void> {
    await this.uploadLogs(entries, shouldAwait);
  }

  /**
   * Returns whether the service is enabled and connected to Azure.
   */
  isConnected(): boolean {
    return this.isEnabled && this.client !== null;
  }
}

// Export singleton getter for convenience
export const getAzureMonitorLogger = (): AzureMonitorLoggingService =>
  AzureMonitorLoggingService.getInstance();
