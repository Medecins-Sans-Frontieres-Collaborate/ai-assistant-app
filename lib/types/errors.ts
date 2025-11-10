/**
 * Error severity levels for pipeline errors.
 */
export enum ErrorSeverity {
  /** Warning - operation can continue */
  WARNING = 'WARNING',

  /** Error - operation failed but pipeline can continue */
  ERROR = 'ERROR',

  /** Critical - pipeline must stop immediately */
  CRITICAL = 'CRITICAL',
}

/**
 * Standardized error codes for the application.
 */
export enum ErrorCode {
  // Authentication & Authorization
  AUTH_FAILED = 'AUTH_FAILED',
  AUTH_SESSION_EXPIRED = 'AUTH_SESSION_EXPIRED',
  AUTH_UNAUTHORIZED = 'AUTH_UNAUTHORIZED',

  // Rate Limiting
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  RATE_LIMIT_QUOTA_EXCEEDED = 'RATE_LIMIT_QUOTA_EXCEEDED',

  // Input Validation
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  INVALID_MODEL = 'INVALID_MODEL',
  INVALID_MESSAGES = 'INVALID_MESSAGES',
  INVALID_TEMPERATURE = 'INVALID_TEMPERATURE',
  INVALID_FILE_TYPE = 'INVALID_FILE_TYPE',
  INVALID_FILE_SIZE = 'INVALID_FILE_SIZE',
  INVALID_IMAGE_URL = 'INVALID_IMAGE_URL',

  // Model & Execution
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
  MODEL_TIMEOUT = 'MODEL_TIMEOUT',
  MODEL_RATE_LIMITED = 'MODEL_RATE_LIMITED',
  MODEL_CONTEXT_TOO_LONG = 'MODEL_CONTEXT_TOO_LONG',

  // File Processing
  FILE_PROCESSING_FAILED = 'FILE_PROCESSING_FAILED',
  FILE_DOWNLOAD_FAILED = 'FILE_DOWNLOAD_FAILED',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  FILE_EXTRACTION_FAILED = 'FILE_EXTRACTION_FAILED',

  // Transcription
  TRANSCRIPTION_FAILED = 'TRANSCRIPTION_FAILED',
  TRANSCRIPTION_TIMEOUT = 'TRANSCRIPTION_TIMEOUT',
  TRANSCRIPTION_QUEUE_FULL = 'TRANSCRIPTION_QUEUE_FULL',

  // RAG & Search
  RAG_SEARCH_FAILED = 'RAG_SEARCH_FAILED',
  RAG_INDEX_NOT_FOUND = 'RAG_INDEX_NOT_FOUND',
  WEB_SEARCH_FAILED = 'WEB_SEARCH_FAILED',

  // Agent
  AGENT_EXECUTION_FAILED = 'AGENT_EXECUTION_FAILED',
  AGENT_NOT_FOUND = 'AGENT_NOT_FOUND',
  AGENT_TIMEOUT = 'AGENT_TIMEOUT',

  // Pipeline
  PIPELINE_TIMEOUT = 'PIPELINE_TIMEOUT',
  PIPELINE_STAGE_FAILED = 'PIPELINE_STAGE_FAILED',

  // External Services
  AZURE_SERVICE_ERROR = 'AZURE_SERVICE_ERROR',
  BLOB_STORAGE_ERROR = 'BLOB_STORAGE_ERROR',
  QUEUE_STORAGE_ERROR = 'QUEUE_STORAGE_ERROR',
  SEARCH_SERVICE_ERROR = 'SEARCH_SERVICE_ERROR',

  // Generic
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
  REQUEST_TIMEOUT = 'REQUEST_TIMEOUT',
}

/**
 * Enhanced error class for pipeline operations.
 * Includes error codes, severity levels, and metadata.
 */
export class PipelineError extends Error {
  /**
   * Creates a new PipelineError.
   *
   * @param code - Standardized error code
   * @param severity - Error severity level
   * @param message - Human-readable error message
   * @param metadata - Additional context about the error
   * @param originalError - The original error that caused this (if any)
   */
  constructor(
    public readonly code: ErrorCode,
    public readonly severity: ErrorSeverity,
    message: string,
    public readonly metadata?: Record<string, any>,
    public readonly originalError?: Error,
  ) {
    super(message);
    this.name = 'PipelineError';

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PipelineError);
    }
  }

  /**
   * Creates a WARNING level error.
   */
  static warning(
    code: ErrorCode,
    message: string,
    metadata?: Record<string, any>,
  ): PipelineError {
    return new PipelineError(code, ErrorSeverity.WARNING, message, metadata);
  }

  /**
   * Creates an ERROR level error.
   */
  static error(
    code: ErrorCode,
    message: string,
    metadata?: Record<string, any>,
    originalError?: Error,
  ): PipelineError {
    return new PipelineError(
      code,
      ErrorSeverity.ERROR,
      message,
      metadata,
      originalError,
    );
  }

  /**
   * Creates a CRITICAL level error.
   */
  static critical(
    code: ErrorCode,
    message: string,
    metadata?: Record<string, any>,
    originalError?: Error,
  ): PipelineError {
    return new PipelineError(
      code,
      ErrorSeverity.CRITICAL,
      message,
      metadata,
      originalError,
    );
  }

  /**
   * Converts this error to a JSON-safe object.
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      severity: this.severity,
      message: this.message,
      metadata: this.metadata,
      stack: this.stack,
    };
  }

  /**
   * Checks if this error should stop the pipeline.
   */
  isCritical(): boolean {
    return this.severity === ErrorSeverity.CRITICAL;
  }

  /**
   * Wraps a standard Error in a PipelineError.
   */
  static fromError(
    error: Error,
    code: ErrorCode = ErrorCode.UNKNOWN_ERROR,
    severity: ErrorSeverity = ErrorSeverity.ERROR,
    metadata?: Record<string, any>,
  ): PipelineError {
    return new PipelineError(code, severity, error.message, metadata, error);
  }
}
