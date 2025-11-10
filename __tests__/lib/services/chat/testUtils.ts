/**
 * Test utilities for backend chat services
 * Provides mock factories and helpers for testing pipeline stages
 */
import { Session } from 'next-auth';

import { ChatContext } from '@/lib/services/chat/pipeline/ChatContext';
import { ModelSelector } from '@/lib/services/shared';

import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT } from '@/lib/utils/app/const';

import { ErrorCode, ErrorSeverity, PipelineError } from '@/lib/types/errors';
import { Message, MessageType } from '@/types/chat';
import { OpenAIModel, OpenAIModelID, OpenAIModels } from '@/types/openai';
import { SearchMode } from '@/types/searchMode';

import { vi } from 'vitest';

/**
 * Creates a mock ModelSelector for testing
 */
function createMockModelSelector(): ModelSelector {
  return {
    selectModel: vi.fn((model: OpenAIModel) => ({
      modelId: model.id,
      modelConfig: model,
    })),
    isValidModel: vi.fn(() => true),
    isCustomAgent: vi.fn(() => false),
    supportsVision: vi.fn(() => false),
  } as unknown as ModelSelector;
}

/**
 * Creates a test Session object
 */
export function createTestSession(overrides?: Partial<Session>): Session {
  return {
    user: {
      id: 'test-user-123',
      email: 'test@example.com',
      name: 'Test User',
      region: 'US',
      ...overrides?.user,
    },
    expires: '2025-12-31T23:59:59.999Z',
    ...overrides,
  } as Session;
}

/**
 * Creates a test Message
 */
export function createTestMessage(overrides?: Partial<Message>): Message {
  return {
    role: 'user',
    content: 'Test message',
    messageType: undefined,
    ...overrides,
  };
}

/**
 * Options for creating a test ChatContext
 */
export interface TestChatContextOptions {
  // Request data
  model?: Partial<OpenAIModel>;
  messages?: Message[];
  systemPrompt?: string;
  temperature?: number;
  stream?: boolean;

  // Content flags
  hasFiles?: boolean;
  hasImages?: boolean;
  hasAudio?: boolean;

  // User context
  user?: Partial<Session['user']>;
  session?: Partial<Session>;

  // Feature flags
  botId?: string;
  searchMode?: SearchMode;
  threadId?: string;
  agentMode?: boolean;
  executionStrategy?: 'standard' | 'agent';

  // Processed data
  processedContent?: any;
  enrichedMessages?: Message[];
}

/**
 * Creates a complete test ChatContext with sensible defaults
 * Reduces boilerplate in tests by providing a ready-to-use context
 */
export function createTestChatContext(
  options: TestChatContextOptions = {},
): ChatContext {
  const session = createTestSession(options.session);
  const model: OpenAIModel = {
    id: DEFAULT_MODEL,
    name: 'GPT-4',
    maxLength: 128000,
    tokenLimit: 16384,
    provider: 'openai',
    ...options.model,
  };

  const messages = options.messages || [createTestMessage()];

  return {
    // Session & User
    session,
    user: session.user,

    // Model & Request
    model,
    modelId: model.id,
    messages,
    systemPrompt: options.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    temperature: options.temperature ?? 1,
    stream: options.stream ?? true,

    // Content Analysis
    contentTypes: new Set(
      options.hasFiles ? ['file'] : options.hasImages ? ['image'] : ['text'],
    ),
    hasFiles: options.hasFiles ?? false,
    hasImages: options.hasImages ?? false,
    hasAudio: options.hasAudio ?? false,

    // Services
    modelSelector: createMockModelSelector(),

    // Features
    botId: options.botId,
    searchMode: options.searchMode,
    threadId: options.threadId,
    agentMode: options.agentMode ?? false,
    executionStrategy: options.executionStrategy,

    // Processing State
    processedContent: options.processedContent || {},
    enrichedMessages: options.enrichedMessages,

    // Metadata
    errors: [],
    metrics: {
      startTime: Date.now(),
      stageTimings: new Map(),
    },
  };
}

/**
 * Creates a minimal ChatContext for testing (reduces noise in tests)
 */
export function createMinimalChatContext(messages?: Message[]): ChatContext {
  return createTestChatContext({ messages });
}

/**
 * Creates a ChatContext with file content
 */
export function createFileContext(fileCount: number = 1): ChatContext {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    type: 'file_url' as const,
    url: `https://example.com/file${i + 1}.pdf`,
    originalFilename: `file${i + 1}.pdf`,
  }));

  return createTestChatContext({
    hasFiles: true,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Analyze these files' }, ...files],
        messageType: MessageType.FILE,
      },
    ],
  });
}

/**
 * Creates a ChatContext with image content
 */
export function createImageContext(imageCount: number = 1): ChatContext {
  const images = Array.from({ length: imageCount }, (_, i) => ({
    type: 'image_url' as const,
    image_url: {
      url: `https://example.com/image${i + 1}.jpg`,
      detail: 'auto' as const,
    },
  }));

  return createTestChatContext({
    hasImages: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in these images?' },
          ...images,
        ],
        messageType: MessageType.IMAGE,
      },
    ],
  });
}

/**
 * Creates a ChatContext with audio content
 */
export function createAudioContext(): ChatContext {
  return createTestChatContext({
    hasAudio: true,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'file_url',
            url: 'https://example.com/audio.mp3',
            originalFilename: 'audio.mp3',
          },
        ],
        messageType: MessageType.FILE,
      },
    ],
  });
}

/**
 * Creates a ChatContext with mixed content (text + files + images)
 */
export function createMixedContext(): ChatContext {
  return createTestChatContext({
    hasFiles: true,
    hasImages: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this' },
          {
            type: 'file_url',
            url: 'https://example.com/doc.pdf',
            originalFilename: 'doc.pdf',
          },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.jpg', detail: 'auto' },
          },
        ],
        messageType: 'MULTI_FILE',
      },
    ],
  });
}

/**
 * Creates a PipelineError for testing
 */
export function createTestError(
  code: ErrorCode = ErrorCode.INTERNAL_ERROR,
  severity: ErrorSeverity = ErrorSeverity.ERROR,
  message: string = 'Test error',
): PipelineError {
  return new PipelineError(code, severity, message);
}

/**
 * Asserts that a context has specific errors
 */
export function expectContextErrors(
  context: ChatContext,
  expectedCodes: ErrorCode[],
): void {
  const actualCodes =
    context.errors
      ?.filter((e): e is PipelineError => e instanceof PipelineError)
      .map((e) => e.code) ?? [];
  expect(actualCodes).toEqual(expectedCodes);
}

/**
 * Asserts that a context has no errors
 */
export function expectNoErrors(context: ChatContext): void {
  expect(context.errors ?? []).toHaveLength(0);
}

/**
 * Waits for a promise to reject with a specific error
 */
export async function expectAsyncError(
  promise: Promise<any>,
  errorCode: ErrorCode,
): Promise<void> {
  await expect(promise).rejects.toThrow();
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineError) {
      expect(error.code).toBe(errorCode);
    } else {
      throw new Error('Expected PipelineError but got different error type');
    }
  }
}

/**
 * Creates a mock ReadableStream for testing streaming responses
 */
export async function* createTestStream(
  values: string[],
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const value of values) {
    yield encoder.encode(value);
  }
}

/**
 * Converts an async generator to an array (for testing)
 */
export async function streamToArray<T>(
  stream: AsyncGenerator<T>,
): Promise<T[]> {
  const result: T[] = [];
  for await (const value of stream) {
    result.push(value);
  }
  return result;
}
