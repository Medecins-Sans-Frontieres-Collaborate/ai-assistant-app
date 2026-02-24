import { Session } from 'next-auth';

import { VALIDATION_LIMITS } from '@/lib/utils/app/const';

import { ChatBody, Message } from '@/types/chat';
import { ErrorCode, PipelineError } from '@/types/errors';
import { OpenAIModel } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';
import { Tone } from '@/types/tone';

import { z } from 'zod';

/**
 * Custom URL validator that accepts both HTTP(S) URLs and data: URLs.
 * This is needed because:
 * - Blob storage URLs are HTTP(S) and should be validated normally
 * - Base64 data URLs (data:image/...) are valid for images in conversation history
 *
 * @param errorMessage - The error message to display on validation failure
 */
const urlOrDataUrl = (errorMessage: string) =>
  z.string().refine(
    (val) => {
      // Accept data: URLs (base64 encoded images/files)
      if (val.startsWith('data:')) return true;
      // Accept relative API URLs (internal file references like /api/file/*)
      if (val.startsWith('/api/')) return true;
      // Otherwise, validate as standard URL
      try {
        new URL(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: errorMessage },
  );

/**
 * Zod schema for message content blocks.
 * Uses a lenient schema to support various content formats.
 */
const MessageContentSchema = z.union([
  z.string().max(100000, 'Message content too long'),
  z.array(
    z.union([
      z.object({
        type: z.literal('text'),
        text: z.string().max(50000, 'Text content too long (max 50,000 chars)'),
      }),
      z.object({
        type: z.literal('image_url'),
        image_url: z.object({
          url: urlOrDataUrl('Invalid image URL'),
          detail: z.enum(['auto', 'low', 'high']).optional(),
        }),
      }),
      z.object({
        type: z.literal('file_url'),
        url: urlOrDataUrl('Invalid file URL'),
      }),
      z.object({
        type: z.literal('thinking'),
        thinking: z.string(),
      }),
    ]),
  ),
]);

/**
 * Zod schema for a single message.
 */
const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: MessageContentSchema,
  // messageType is optional metadata for frontend UI hints - not validated
  messageType: z.string().optional(),
  // Optional metadata fields
  toneId: z.string().nullable().optional(),
  promptId: z.string().nullable().optional(),
  promptVariables: z.record(z.string(), z.string()).optional(),
  // Artifact context for code editor
  artifactContext: z
    .object({
      fileName: z.string(),
      language: z.string(),
      code: z.string().max(100000, 'Artifact code too long'),
    })
    .optional(),
  // Citations from web search
  citations: z.array(z.any()).optional(),
  // Thinking content for reasoning models
  thinking: z.string().optional(),
  // Transcript metadata for audio/video
  transcript: z.any().optional(),
  // Error flag
  error: z.boolean().optional(),
});

/**
 * Zod schema for OpenAI model configuration.
 */
const OpenAIModelSchema = z.object({
  id: z.string().min(1, 'Model ID is required'),
  name: z.string().min(1, 'Model name is required'),
  maxLength: z.number().positive().optional(),
  tokenLimit: z.number().positive().optional(),
  // Agent-specific fields (for custom agents and built-in agents)
  isAgent: z.boolean().optional(),
  isCustomAgent: z.boolean().optional(),
  agentId: z.string().optional(),
  // Add other fields as needed but keep them optional
  // to avoid breaking existing code
}) as z.ZodType<OpenAIModel>;

/**
 * Zod schema for Tone configuration.
 */
const ToneSchema = z.object({
  id: z.string().min(1, 'Tone ID is required'),
  name: z.string().min(1, 'Tone name is required'),
  description: z.string(),
  voiceRules: z.string().max(10000, 'Voice rules too long (max 10,000 chars)'),
  examples: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  folderId: z.string().nullable(),
  model: OpenAIModelSchema.optional(),
  templateId: z.string().optional(),
  templateName: z.string().optional(),
  importedAt: z.string().optional(),
});

/**
 * Zod schema for streaming speed configuration.
 */
const StreamingSpeedSchema = z.object({
  charsPerBatch: z.number().int().min(1).max(20),
  delayMs: z.number().int().min(1).max(100),
});

/**
 * Zod schema for the main chat request body.
 */
const ChatBodySchema = z
  .object({
    model: OpenAIModelSchema,
    messages: z
      .array(MessageSchema)
      .min(1, 'At least one message is required')
      .max(100, 'Too many messages (max 100)'),
    prompt: z
      .string()
      .max(10000, 'System prompt too long (max 10,000 chars)')
      .optional(),
    temperature: z
      .number()
      .min(0, 'Temperature must be >= 0')
      .max(2, 'Temperature must be <= 2')
      .optional(),
    stream: z.boolean().optional().default(true),
    reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
    verbosity: z.enum(['low', 'medium', 'high']).optional(),
    botId: z.string().max(100, 'Bot ID too long').optional(),
    searchMode: z.nativeEnum(SearchMode).optional(),
    codeInterpreterMode: z.enum(['off', 'intelligent', 'always']).optional(),
    threadId: z.string().max(100, 'Thread ID too long').optional(),
    forcedAgentType: z.string().max(50, 'Agent type too long').optional(),
    tone: ToneSchema.optional(), // Full tone object from client
    streamingSpeed: StreamingSpeedSchema.optional(), // Smooth streaming speed configuration
    includeUserInfoInPrompt: z.boolean().optional(), // Include user info in system prompt
    preferredName: z
      .string()
      .max(100, 'Preferred name too long (max 100 chars)')
      .optional(),
    userContext: z
      .string()
      .max(2000, 'User context too long (max 2,000 chars)')
      .optional(),
    displayNamePreference: z
      .enum(['firstName', 'lastName', 'fullName', 'custom', 'none'])
      .optional(),
    customDisplayName: z
      .string()
      .max(100, 'Custom display name too long (max 100 chars)')
      .optional(),
  })
  .strict(); // Reject unknown properties

/**
 * InputValidator validates and sanitizes incoming chat requests.
 *
 * Security features:
 * - Validates all input against schemas
 * - Prevents oversized requests
 * - Sanitizes URLs
 * - Rejects malformed data
 * - Prevents injection attacks
 */
export class InputValidator {
  /**
   * Validates a chat request body.
   *
   * @param body - The raw request body
   * @returns The validated and typed ChatBody
   * @throws PipelineError if validation fails
   */
  public validateChatRequest(body: unknown): ChatBody & {
    searchMode?: SearchMode;
    threadId?: string;
    forcedAgentType?: string;
    tone?: Tone;
  } {
    try {
      const result = ChatBodySchema.safeParse(body);

      if (!result.success) {
        const firstError = result.error.issues[0];
        const errorMessage = firstError
          ? `${firstError.path.join('.')}: ${firstError.message}`
          : 'Invalid request body';

        throw PipelineError.critical(
          ErrorCode.VALIDATION_FAILED,
          `Chat request validation failed: ${errorMessage}`,
          {
            validationErrors: result.error.issues,
          },
        );
      }

      // Cast to include key property (it's auto-generated in the actual request)
      return result.data as ChatBody & {
        searchMode?: SearchMode;
        threadId?: string;
        forcedAgentType?: string;
      };
    } catch (error) {
      if (error instanceof PipelineError) {
        throw error;
      }

      throw PipelineError.critical(
        ErrorCode.VALIDATION_FAILED,
        'Failed to validate chat request',
        {
          originalError: error instanceof Error ? error.message : String(error),
        },
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Validates that a file URL is from an allowed domain.
   * Prevents SSRF attacks.
   *
   * @param url - The file URL to validate
   * @returns true if valid, false otherwise
   */
  public isValidFileUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url);

      // Only allow blob URLs from Azure Blob Storage
      const allowedHosts = [
        '.blob.core.windows.net',
        'localhost', // For local development
      ];

      const isAllowed = allowedHosts.some((host) =>
        parsedUrl.hostname.endsWith(host),
      );

      if (!isAllowed) {
        console.warn(
          `[InputValidator] Rejected file URL from unauthorized host: ${parsedUrl.hostname}`,
        );
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sanitizes a string to prevent injection attacks.
   * Removes potentially dangerous characters.
   *
   * @param input - The string to sanitize
   * @param maxLength - Maximum allowed length
   * @returns Sanitized string
   */
  public sanitizeString(input: string, maxLength: number = 10000): string {
    // Trim and limit length
    let sanitized = input.trim().slice(0, maxLength);

    // Remove null bytes (potential injection vector)
    sanitized = sanitized.replace(/\0/g, '');

    return sanitized;
  }

  /**
   * Validates the total size of a request.
   * Prevents memory exhaustion attacks.
   *
   * Note: This limit is for the JSON request body only (messages + metadata).
   * Actual file/image/audio data is uploaded separately via /api/file/upload.
   * The chat endpoint only receives URLs.
   *
   * @param body - The request body
   * @param maxSize - Maximum allowed size in bytes (defaults to VALIDATION_LIMITS.REQUEST_BODY_MAX_BYTES)
   * @returns true if size is acceptable
   */
  public validateRequestSize(
    body: unknown,
    maxSize: number = VALIDATION_LIMITS.REQUEST_BODY_MAX_BYTES,
  ): boolean {
    try {
      const size = JSON.stringify(body).length;

      if (size > maxSize) {
        console.warn(
          `[InputValidator] Request size ${size} bytes exceeds maximum ${maxSize} bytes`,
        );
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validates file size before downloading.
   * Prevents OOM crashes from large files being loaded into memory.
   *
   * This validation happens BEFORE downloading the file from blob storage,
   * so we only fetch metadata (Content-Length) without downloading the actual content.
   *
   * @param fileUrl - The blob storage URL
   * @param user - User session for authentication
   * @param getFileSizeFn - Function to get file size (dependency injection for testing)
   * @param maxSize - Maximum allowed file size in bytes (defaults to VALIDATION_LIMITS.FILE_DOWNLOAD_MAX_BYTES)
   * @throws PipelineError.critical if file exceeds size limit
   */
  public async validateFileSize(
    fileUrl: string,
    user: Session['user'],
    getFileSizeFn: (url: string, user: Session['user']) => Promise<number>,
    maxSize: number = VALIDATION_LIMITS.FILE_DOWNLOAD_MAX_BYTES,
  ): Promise<void> {
    try {
      const fileSize = await getFileSizeFn(fileUrl, user);

      if (fileSize > maxSize) {
        const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);
        const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(2);

        throw PipelineError.critical(
          ErrorCode.VALIDATION_FAILED,
          `File size ${fileSizeMB}MB exceeds maximum allowed size of ${maxSizeMB}MB`,
          {
            fileUrl,
            fileSize,
            maxSize,
          },
        );
      }

      console.log(
        `[InputValidator] File size validation passed: ${(fileSize / (1024 * 1024)).toFixed(2)}MB`,
      );
    } catch (error) {
      if (error instanceof PipelineError) {
        throw error;
      }

      throw PipelineError.critical(
        ErrorCode.VALIDATION_FAILED,
        'Failed to validate file size',
        {
          fileUrl,
          originalError: error instanceof Error ? error.message : String(error),
        },
        error instanceof Error ? error : undefined,
      );
    }
  }
}
