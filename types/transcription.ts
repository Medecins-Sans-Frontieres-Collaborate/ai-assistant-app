/**
 * Options for transcription services.
 *
 * @property language - ISO-639-1 language code (e.g., 'en', 'es', 'fr').
 *                      If undefined, Whisper will auto-detect the language.
 * @property prompt - Optional context/instructions to improve transcription accuracy.
 *                    Useful for technical terms, proper nouns, or specific formatting.
 */
export interface TranscriptionOptions {
  language?: string;
  prompt?: string;
}

/**
 * Interface for transcription services.
 *
 * Implemented by:
 * - WhisperTranscriptionService: Synchronous transcription for files ≤25MB
 * - BatchTranscriptionService: Asynchronous transcription for files >25MB
 */
export interface ITranscriptionService {
  transcribe(input: string, options?: TranscriptionOptions): Promise<string>;
}

/**
 * Response from the transcription API endpoint.
 *
 * For synchronous (Whisper) transcription:
 *   - async: false
 *   - transcript: the transcribed text
 *
 * For asynchronous (Batch) transcription:
 *   - async: true
 *   - jobId: ID to poll for status
 */
export interface TranscriptionResponse {
  /** Whether this is an async (batch) transcription */
  async: boolean;
  /** The transcript text (only for sync transcriptions or completed async) */
  transcript?: string;
  /** Job ID for polling (only for async transcriptions) */
  jobId?: string;
}

/**
 * Progress information for chunked transcription jobs.
 */
export interface TranscriptionProgress {
  /** Number of chunks completed */
  completed: number;
  /** Total number of chunks */
  total: number;
}

/**
 * Status response when polling a transcription job.
 *
 * Supports both:
 * - Chunked jobs: Local processing with FFmpeg + Whisper
 * - Batch jobs: Azure Speech Services (legacy)
 */
export interface BatchTranscriptionStatusResponse {
  /** Current status of the job */
  status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed';
  /** Transcript text (only when status is 'Succeeded') */
  transcript?: string;
  /** Error message (only when status is 'Failed') */
  error?: string;
  /**
   * Classification of the failure so clients can pick the right recovery UX
   * (retry vs re-auth vs unsupported-format). Only set when the server has
   * a confident classification; absent for unknown errors or non-failure states.
   */
  errorClass?: TranscriptionErrorClass;
  /**
   * True when the server-side job was cancelled by the user. The top-level
   * `status` is still mapped to `'Failed'` for backwards compatibility, but
   * clients that care should branch on this flag before rendering a generic
   * "failed" message.
   */
  cancelled?: boolean;
  /** Progress for chunked transcription jobs */
  progress?: TranscriptionProgress;
  /** Type of job ('chunked' or 'batch') */
  jobType?: 'chunked' | 'batch';
  /** When the job was created */
  createdAt?: string;
  /** When the job completed (only when finished) */
  completedAt?: string;
  /** Human-readable status message */
  message?: string;
}

/**
 * Reference to a transcript stored in blob storage.
 *
 * Used for large transcripts (>10KB) that are stored externally
 * rather than inline in the message content.
 */
export interface TranscriptReference {
  /** Original filename of the transcribed media */
  filename: string;
  /** Job ID for the transcription */
  jobId: string;
  /** Path to the transcript in blob storage */
  blobPath: string;
  /** ISO timestamp when the transcript expires */
  expiresAt: string;
}

/** Size threshold above which transcripts are stored in blob storage (10KB) */
export const TRANSCRIPT_BLOB_THRESHOLD = 10 * 1024;

/** Number of days before transcript expires */
export const TRANSCRIPT_EXPIRY_DAYS = 7;

/**
 * How transcription errors classify for retry decisions.
 * - `auth`: credential expired or invalid — re-init credentials and retry.
 * - `rate_limit`: backoff and retry.
 * - `transient`: 5xx / network — backoff and retry.
 * - `permanent`: 4xx (not 401/403/429) — don't retry.
 * - `unknown`: unclassified — treat as transient once.
 */
export type TranscriptionErrorClass =
  | 'auth'
  | 'rate_limit'
  | 'transient'
  | 'permanent'
  | 'unknown';

export interface TranscriptionError extends Error {
  errorClass: TranscriptionErrorClass;
}
