import {
  DEFAULT_ANALYSIS_MAX_TOKENS,
  DEFAULT_ANALYSIS_MODEL,
} from '@/lib/utils/app/const';

import {
  WorkflowEventPayload,
  emitAgentActivity,
  emitWorkflowEvent,
} from '@/lib/streamMarkers';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import { AzureOpenAI } from 'openai';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';

/**
 * Shared LLM plumbing for the conversation-workflow routes
 * (`app/api/workflows/*`). Extracts the Azure client construction and the
 * strict json_schema call shape proven in `app/api/chat/translate/route.ts`
 * so each workflow's orchestrator stays about its prompts, not transport.
 */

export function createAzureClient(): AzureOpenAI {
  const azureADTokenProvider = getBearerTokenProvider(
    new DefaultAzureCredential(),
    'https://cognitiveservices.azure.com/.default',
  );
  return new AzureOpenAI({
    azureADTokenProvider,
    apiVersion: '2024-08-01-preview',
  });
}

export interface StructuredCallOptions {
  client: AzureOpenAI;
  system: string;
  /**
   * Plain prompt text, or content parts for multimodal calls (e.g. photo
   * extraction: a text part plus image_url parts with base64 data URLs —
   * the model must be vision-capable; see resolveVisionWorkflowModelId).
   */
  user: string | ChatCompletionContentPart[];
  schemaName: string;
  /** Strict JSON schema for the response body. */
  schema: Record<string, unknown>;
  model?: string;
  maxTokens?: number;
}

/**
 * One strict structured-output call. Throws on refusal or empty content so
 * orchestrators can convert failures into a single user-facing error.
 */
export async function callStructured<T>(
  options: StructuredCallOptions,
): Promise<T> {
  const {
    client,
    system,
    user,
    schemaName,
    schema,
    model = DEFAULT_ANALYSIS_MODEL,
    maxTokens = DEFAULT_ANALYSIS_MAX_TOKENS,
  } = options;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_completion_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    },
  });

  const choice = response.choices?.[0];
  if (!choice) {
    throw new Error('No choices returned from AI');
  }
  if (choice.message?.refusal) {
    throw new Error(`Request refused: ${choice.message.refusal}`);
  }
  const content = choice.message?.content;
  if (!content) {
    throw new Error(
      `Empty AI response (finish reason: ${choice.finish_reason})`,
    );
  }
  return JSON.parse(content) as T;
}

export interface StreamedTextCallOptions {
  client: AzureOpenAI;
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
  /** Called per token delta. */
  onDelta: (delta: string) => void;
  signal?: AbortSignal;
}

/** Streams a plain-text completion, returning the full accumulated text. */
export async function callStreamedText(
  options: StreamedTextCallOptions,
): Promise<string> {
  const {
    client,
    system,
    user,
    model = DEFAULT_ANALYSIS_MODEL,
    maxTokens = DEFAULT_ANALYSIS_MAX_TOKENS,
    onDelta,
    signal,
  } = options;

  const stream = await client.chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_completion_tokens: maxTokens,
      stream: true,
    },
    { signal },
  );

  let full = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  }
  return full;
}

export interface WorkflowStreamWriter {
  /** Transient loader text: `chat.activity.*` translation key + params. */
  activity: (key: string, params?: Record<string, string>) => void;
  /** Structured workflow result event. */
  event: (payload: WorkflowEventPayload) => void;
  /** Plain display text (streams into the workspace). */
  text: (delta: string) => void;
  /** Closes the stream. Safe to call once. */
  close: () => void;
  /** Closes the stream after emitting a final error event. */
  fail: (workflow: WorkflowEventPayload['workflow'], message: string) => void;
}

/**
 * A text/plain response stream multiplexing display text and sentinel
 * markers, matching the chat streaming wire format so `scanStreamEvents`
 * on the client parses it unchanged.
 */
export function createWorkflowStream(): {
  stream: ReadableStream<Uint8Array>;
  writer: WorkflowStreamWriter;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });

  const write = (text: string) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      closed = true;
    }
  };

  const writer: WorkflowStreamWriter = {
    activity: (key, params) => write(emitAgentActivity(key, params)),
    event: (payload) => write(emitWorkflowEvent(payload)),
    text: (delta) => write(delta),
    close: () => {
      if (closed || !controller) return;
      closed = true;
      try {
        controller.close();
      } catch {
        // already closed by cancellation
      }
    },
    fail: (workflow, message) => {
      writer.event({ workflow, type: 'error', data: { message } });
      writer.close();
    },
  };

  return { stream, writer };
}
