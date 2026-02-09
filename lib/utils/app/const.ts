import { env } from '@/config/environment';

// Re-export for backward compatibility
// The actual implementation is now in systemPrompt.ts
export {
  DEFAULT_USER_PROMPT as DEFAULT_SYSTEM_PROMPT,
  buildSystemPrompt,
} from './systemPrompt';

export const DEFAULT_TEMPERATURE = parseFloat(
  env.NEXT_PUBLIC_DEFAULT_TEMPERATURE,
);

export const DEFAULT_USE_KNOWLEDGE_BASE = env.DEFAULT_USE_KNOWLEDGE_BASE;

export const OPENAI_API_VERSION = env.OPENAI_API_VERSION;

export const DEFAULT_MODEL = env.DEFAULT_MODEL;

export const FORCE_LOGOUT_ON_REFRESH_FAILURE =
  env.FORCE_LOGOUT_ON_REFRESH_FAILURE;

// =============================================================================
// File Upload Size Limits
// =============================================================================

// File upload size limits (in bytes)
export const FILE_SIZE_LIMITS = {
  // Media files - by file size
  IMAGE_MAX_BYTES: 5 * 1024 * 1024, // 5MB
  AUDIO_MAX_BYTES: 1024 * 1024 * 1024, // 1GB (for transcription)
  VIDEO_MAX_BYTES: 1.5 * 1024 * 1024 * 1024, // 1.5GB (audio extracted)

  // Documents - by file size (initial gate before content validation)
  DOCUMENT_MAX_BYTES: 50 * 1024 * 1024, // 50MB

  // Upload chunks
  UPLOAD_CHUNK_BYTES: 5 * 1024 * 1024, // 5MB chunks

  // Backward compatibility aliases (deprecated - use new names)
  /** @deprecated Use AUDIO_MAX_BYTES instead */
  AUDIO_VIDEO_MAX_BYTES: 1024 * 1024 * 1024, // Now same as AUDIO_MAX_BYTES
  /** @deprecated Use DOCUMENT_MAX_BYTES instead */
  FILE_MAX_BYTES: 50 * 1024 * 1024, // Now same as DOCUMENT_MAX_BYTES
} as const;

// Content limits for text-based files (validated after upload/extraction)
export const CONTENT_LIMITS = {
  // PDF: limit by page count
  PDF_MAX_PAGES: 500,

  // Text files: limit by character count (estimate ~4 chars per token)
  TEXT_MAX_CHARACTERS: 400_000, // ~100K tokens

  // Token estimation factor (for display purposes)
  CHARS_PER_TOKEN_ESTIMATE: 4,
} as const;

/**
 * Token estimation ratios for different character scripts.
 * These values represent approximate characters per token for each script type.
 * Used for dynamic chunk sizing based on content language.
 */
export const TOKEN_ESTIMATION = {
  /** English and European languages using Latin script */
  LATIN: 4,
  /** Chinese, Japanese (Kanji), Korean (Hanja) - very short tokens */
  CJK: 1.5,
  /** Arabic, Hebrew, Cyrillic, and other non-Latin scripts */
  RTL_CYRILLIC: 2.5,
  /** Fallback for unknown or mixed content - conservative estimate */
  CONSERVATIVE: 2,
} as const;

// =============================================================================
// Display Formatting Utilities
// =============================================================================

/**
 * Formats bytes to a human-readable string (e.g., "5MB", "1.5GB").
 * Used to generate display strings from byte constants.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    return gb % 1 === 0 ? `${gb}GB` : `${gb.toFixed(1)}GB`;
  }
  return `${bytes / (1024 * 1024)}MB`;
}

/**
 * Formats large numbers with K/M suffixes (e.g., "400K", "1M").
 */
export function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${num / 1_000_000}M`;
  if (num >= 1_000) return `${num / 1_000}K`;
  return String(num);
}

// Display-friendly limits - dynamically derived from byte values
export const FILE_SIZE_LIMITS_DISPLAY = {
  IMAGE: formatBytes(FILE_SIZE_LIMITS.IMAGE_MAX_BYTES),
  AUDIO: formatBytes(FILE_SIZE_LIMITS.AUDIO_MAX_BYTES),
  VIDEO: formatBytes(FILE_SIZE_LIMITS.VIDEO_MAX_BYTES),
  DOCUMENT: formatBytes(FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES),
  PDF_PAGES: `${CONTENT_LIMITS.PDF_MAX_PAGES} pages`,
  TEXT_CHARS: `${formatNumber(CONTENT_LIMITS.TEXT_MAX_CHARACTERS)} characters`,
} as const;

// File upload size limits (in MB for display) - backward compatibility
// Values are derived from byte constants to stay in sync
export const FILE_SIZE_LIMITS_MB = {
  IMAGE: FILE_SIZE_LIMITS.IMAGE_MAX_BYTES / (1024 * 1024),
  AUDIO: FILE_SIZE_LIMITS.AUDIO_MAX_BYTES / (1024 * 1024),
  AUDIO_VIDEO: FILE_SIZE_LIMITS.AUDIO_MAX_BYTES / (1024 * 1024), // Deprecated alias
  VIDEO: FILE_SIZE_LIMITS.VIDEO_MAX_BYTES / (1024 * 1024),
  DOCUMENT: FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES / (1024 * 1024),
  FILE: FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES / (1024 * 1024), // Deprecated alias
} as const;

// Whisper API size limit for transcription (25MB API limit, but we process larger files via chunking)
export const WHISPER_MAX_SIZE = 25 * 1024 * 1024; // 25MB

// File upload count limits per message
export const FILE_COUNT_LIMITS = {
  MAX_IMAGES: 10, // OpenAI vision models support up to 10 images
  MAX_DOCUMENTS: 3, // Document summarization is expensive
  MAX_AUDIO_VIDEO: 1, // Transcription is expensive (time + cost)
  MAX_TOTAL_FILES: 10, // Total attachments (any type)
  MAX_TOTAL_SIZE: FILE_SIZE_LIMITS.VIDEO_MAX_BYTES, // 1.5GB total per message (matches largest file type)
} as const;

// Maximum file upload size for API endpoints (in bytes)
// Set to 1.5GB to support large video files (audio is extracted)
export const MAX_API_FILE_SIZE = FILE_SIZE_LIMITS.VIDEO_MAX_BYTES;

// Validation limits for server-side checks
export const VALIDATION_LIMITS = {
  // Maximum size for JSON request body (chat messages + metadata)
  REQUEST_BODY_MAX_BYTES: 10 * 1024 * 1024, // 10MB
  // Maximum file size for pre-download validation (matches largest file type)
  FILE_DOWNLOAD_MAX_BYTES: FILE_SIZE_LIMITS.VIDEO_MAX_BYTES, // 1.5GB
} as const;

// Default model for AI analysis operations (tone analysis, prompt revision, etc.)
// Uses 'gpt-5' - reasoning model with advanced analysis capabilities
export const DEFAULT_ANALYSIS_MODEL = 'gpt-5';

// Default max tokens for AI analysis operations
export const DEFAULT_ANALYSIS_MAX_TOKENS = 100000;

// Note: GPT-5 is a reasoning model and does not support custom temperature
// Temperature is automatically set to 1 by the model

// API route timeouts (in seconds)
export const API_TIMEOUTS = {
  DEFAULT: 60,
  CHAT: 300,
  FILE_PROCESSING: 120,
  TRANSCRIPTION: 180,
  BATCH_TRANSCRIPTION: 600, // 10 minutes for large audio files (>25MB)
} as const;

// =============================================================================
// Document Chunking Configuration
// =============================================================================

/**
 * Configuration for dynamic document chunking based on model context window.
 * These values define bounds for chunk size, batch size, and summary length
 * that scale with the selected model's capabilities.
 */
export const CHUNK_CONFIG = {
  // Chunk size bounds (in characters)
  MIN_CHUNK_CHARS: 4000,
  MAX_CHUNK_CHARS: 20000,
  DEFAULT_CHUNK_CHARS: 6000,

  // Reserved tokens for system prompt, response buffer, and safety margin
  RESERVED_TOKENS: 1000,

  // Batch size bounds (number of chunks processed in parallel)
  MIN_BATCH_SIZE: 3,
  MAX_BATCH_SIZE: 10,
  DEFAULT_BATCH_SIZE: 5,

  // Maximum summary length bounds (in characters)
  MIN_SUMMARY_LENGTH: 16000,
  MAX_SUMMARY_LENGTH: 64000,
  DEFAULT_SUMMARY_LENGTH: 16000,

  // Default max completion tokens for summarization
  DEFAULT_MAX_COMPLETION_TOKENS: 5000,
} as const;
