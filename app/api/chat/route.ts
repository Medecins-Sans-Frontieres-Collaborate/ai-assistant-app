import { NextRequest } from 'next/server';

import { ServiceContainer } from '@/lib/services/ServiceContainer';
import { createBlobStorageClient } from '@/lib/services/blobStorageFactory';
import { AgentEnricher } from '@/lib/services/chat/enrichers/AgentEnricher';
import { ExtractionEnricher } from '@/lib/services/chat/enrichers/ExtractionEnricher';
import { PromptAgentEnricher } from '@/lib/services/chat/enrichers/PromptAgentEnricher';
import { RAGEnricher } from '@/lib/services/chat/enrichers/RAGEnricher';
import { ToolRouterEnricher } from '@/lib/services/chat/enrichers/ToolRouterEnricher';
import { AgentChatHandler } from '@/lib/services/chat/handlers/AgentChatHandler';
import { StandardChatHandler } from '@/lib/services/chat/handlers/StandardChatHandler';
import { ChatPipeline, buildChatContext } from '@/lib/services/chat/pipeline';
import { FileProcessor } from '@/lib/services/chat/processors/FileProcessor';
import { ImageProcessor } from '@/lib/services/chat/processors/ImageProcessor';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { ErrorCode, PipelineError } from '@/types/errors';

import { env } from '@/config/environment';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';
import { emitAgentActivity } from '@/lib/streamMarkers';

/**
 * POST /api/chat
 *
 * UNIFIED CHAT ENDPOINT
 *
 * Handles ALL types of chat requests through a composable pipeline:
 * - Text-only conversations
 * - Image conversations (vision models)
 * - File analysis (documents)
 * - Audio/video transcription
 * - Mixed content (files + images)
 * - RAG with knowledge bases
 * - Intelligent search (tool routing)
 * - Code interpreter (native or sub-tool round-trip)
 * - AI Foundry agents
 *
 * ANY COMBINATION of the above is supported through composition.
 *
 * Streaming contract: for streaming requests the byte stream is returned
 * IMMEDIATELY after context construction (auth, rate limit, validation —
 * which still fail with real HTTP status codes). The pipeline then runs in
 * the background writing into the stream, so pre-generation stages (web
 * search, code interpreter, RAG) surface their AGENT_ACTIVITY progress
 * markers live instead of buffering until the model starts. Failures after
 * the stream has started are reported IN-BAND via the terminal
 * `streamError` metadata block (see lib/utils/app/metadata.ts) — the client
 * surfaces them as an error card with Try Again; aborting the socket
 * instead would show as an opaque network error.
 *
 * Non-streaming requests keep the classic behavior: single JSON body,
 * errors as HTTP status codes.
 */
export async function POST(req: NextRequest): Promise<Response> {
  // Guard for the pipeline execution phase. Large video files (351MB+) can
  // take 60-90s to download, plus extraction and batch job submission.
  const timeoutMs = 300000;

  // Set up a TransformStream so pipeline stages can emit AGENT_ACTIVITY /
  // TOOL_CALL_RECORD markers in real time (e.g. "Searching: …") rather
  // than the user staring at a generic "Thinking…" through the slow
  // pre-stream stages. For streaming requests the readable side is
  // returned to the client BEFORE the pipeline runs — that early return is
  // what makes the markers actually arrive live.
  const { readable: streamReadable, writable: streamWritable } =
    new TransformStream<Uint8Array, Uint8Array>();
  const streamWriter = streamWritable.getWriter();
  const activityEncoder = new TextEncoder();

  const emitActivity = async (
    key: string,
    params?: Record<string, string>,
  ): Promise<void> => {
    void streamWriter
      .write(activityEncoder.encode(emitAgentActivity(key, params)))
      .catch(() => {
        // Writer may have been closed by an error path.
      });
  };
  // Raw sibling of emitActivity for pre-encoded markers (e.g. a code
  // interpreter TOOL_CALL_RECORD emitted by an enricher before the model
  // stream starts). Same non-blocking semantics.
  const emitMarker = async (marker: string): Promise<void> => {
    void streamWriter.write(activityEncoder.encode(marker)).catch(() => {
      // Writer may have been closed by an error path.
    });
  };

  /** In-band failure report for streams that have already started. */
  const writeStreamError = async (
    message: string,
    code?: string,
  ): Promise<void> => {
    const payload = `\n\n<<<METADATA_START>>>${JSON.stringify({
      streamError: { message, ...(code ? { code } : {}) },
    })}<<<METADATA_END>>>`;
    try {
      await streamWriter.write(activityEncoder.encode(payload));
    } catch {
      // Writer already closed/aborted — nothing more we can report.
    }
  };

  const abortWriter = async (err: unknown): Promise<void> => {
    try {
      await streamWriter.abort(
        err instanceof Error ? err : new Error(String(err)),
      );
    } catch {
      // already closed / errored
    }
  };

  const closeWriter = async (): Promise<void> => {
    try {
      await streamWriter.close();
    } catch {
      // already closed / errored
    }
  };

  try {
    // 1. Build context through middleware (auth, rate limit, validation,
    // credentials). Failures HERE still produce real HTTP status codes —
    // nothing has been streamed yet.
    console.log('[Unified Chat] Building context...');
    const context = await buildChatContext(req);
    context.emitActivity = emitActivity;
    context.emitMarker = emitMarker;

    console.log('[Unified Chat] Context built:', {
      model: context.modelId,
      contentTypes: Array.from(context.contentTypes),
      hasFiles: context.hasFiles,
      hasImages: context.hasImages,
      hasRAG: !!context.botId,
      searchMode: context.searchMode, // Show actual value instead of boolean
      interpreterMode: context.interpreterMode,
      hasAgent: context.agentMode,
    });

    // 2. Get services from container (singleton, reused across requests)
    const container = ServiceContainer.getInstance();
    const fileProcessingService = container.getFileProcessingService();
    const toolRouterService = container.getToolRouterService();
    const agentChatService = container.getAgentChatService();
    const aiFoundryAgentHandler = container.getAIFoundryAgentHandler();
    const standardChatService = container.getStandardChatService();

    // 3. Build pipeline
    const inputValidator = new InputValidator();
    // Create blob storage client for batch transcription support
    const blobStorageClient = createBlobStorageClient(context.session);
    // Get Foundry OpenAI client for RAG service (uses gpt-5-mini for query reformulation)
    const foundryOpenAIClient = container.getOpenAIClient();
    const pipeline = new ChatPipeline([
      // Content processors
      new FileProcessor(
        fileProcessingService,
        inputValidator,
        blobStorageClient,
      ),
      new ImageProcessor(),

      // Feature enrichers
      // Prompt-agent persona override runs BEFORE RAGEnricher: both key
      // off botId, and RAGEnricher.shouldRun skips prompt agents.
      new PromptAgentEnricher(),
      new RAGEnricher(
        env.SEARCH_ENDPOINT!,
        env.SEARCH_INDEX!,
        foundryOpenAIClient,
      ),
      new ToolRouterEnricher(toolRouterService, agentChatService),
      // Structured-data extraction: composes the JSON-schema response
      // format when the request carries an `extraction` payload.
      new ExtractionEnricher(agentChatService),
      new AgentEnricher(),

      // Execution handlers (AgentChatHandler runs first, StandardChatHandler as fallback)
      new AgentChatHandler(aiFoundryAgentHandler),
      new StandardChatHandler(standardChatService),
    ]);

    const executePipeline = async () => {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            PipelineError.critical(
              ErrorCode.REQUEST_TIMEOUT,
              `Request timed out after ${timeoutMs / 1000} seconds`,
              { timeoutMs },
            ),
          );
        }, timeoutMs);
      });
      return await Promise.race([pipeline.execute(context), timeoutPromise]);
    };

    // ── Non-streaming: classic single-response behavior ────────────────
    if (!context.stream) {
      try {
        const result = await executePipeline();
        const errorResponse = buildPipelineErrorResponse(result);
        if (errorResponse) return errorResponse;
        return result.response!;
      } finally {
        await abortWriter(new Error('non-streaming request'));
      }
    }

    // ── Streaming: return the stream NOW, run the pipeline behind it ───
    void (async () => {
      let aborted = false;
      try {
        const result = await executePipeline();

        if (result.errors && result.errors.length > 0 && !result.response) {
          const firstError = result.errors[0];
          console.error(
            '[Unified Chat] Pipeline failed:',
            result.errors.map((e) => sanitizeForLog(e.message)),
          );
          await writeStreamError(
            firstError.message,
            firstError instanceof PipelineError
              ? firstError.code
              : ErrorCode.INTERNAL_ERROR,
          );
          return;
        }
        if (result.errors && result.errors.length > 0) {
          console.error(
            '[Unified Chat] Pipeline completed with errors:',
            result.errors.map((e) => sanitizeForLog(e.message)),
          );
        }
        if (!result.response) {
          await writeStreamError(
            'Pipeline did not generate a response',
            ErrorCode.INTERNAL_ERROR,
          );
          return;
        }

        const ctype = result.response.headers?.get?.('content-type') ?? '';
        if (!ctype.startsWith('text/plain') || !result.response.body) {
          // A JSON body despite a streaming request (e.g. a handler's
          // misconfiguration 503). The HTTP status is already committed as
          // 200, so convey failure in-band; a successful JSON body is
          // written through — StreamParser.finalize() parses `{text: …}`.
          const bodyText = result.response.body
            ? await result.response.text()
            : '';
          if (result.response.status >= 400) {
            let message = 'Chat request failed';
            try {
              const parsed = JSON.parse(bodyText);
              message = parsed.message || parsed.error || message;
            } catch {
              // non-JSON error body — keep the generic message
            }
            await writeStreamError(message, String(result.response.status));
          } else if (bodyText) {
            await streamWriter.write(activityEncoder.encode(bodyText));
          }
          return;
        }

        console.log('[Unified Chat] Piping handler stream to client');
        const reader = result.response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await streamWriter.write(value);
          }
        } catch (pipeErr) {
          // Mid-stream failure after real content flowed: abort so the
          // client's reader sees the break instead of a fake-clean end.
          console.error('[Unified Chat] Stream pipe error:', pipeErr);
          aborted = true;
          await abortWriter(pipeErr);
        }
      } catch (err) {
        // Pipeline threw before any handler bytes were piped — report
        // in-band and end cleanly (error card with Try Again client-side).
        console.error('[Unified Chat] Error:', sanitizeForLog(err));
        await writeStreamError(
          err instanceof Error ? err.message : 'Chat request failed',
          err instanceof PipelineError ? err.code : ErrorCode.INTERNAL_ERROR,
        );
      } finally {
        if (!aborted) {
          await closeWriter();
        }
      }
    })();

    return new Response(streamReadable, {
      status: 200,
      headers: STREAMING_RESPONSE_HEADERS,
    });
  } catch (error) {
    // Context construction failed — the stream was never returned, so
    // classic HTTP error semantics apply (auth 401, validation 400, …).
    await abortWriter(error);
    console.error('[Unified Chat] Error:', sanitizeForLog(error));

    if (error instanceof PipelineError) {
      return new Response(
        JSON.stringify({
          error: error.severity === 'CRITICAL' ? 'Critical Error' : 'Error',
          code: error.code,
          message: error.message,
          ...(error.metadata && { metadata: error.metadata }),
        }),
        {
          status: getStatusCodeForPipelineError(error.code),
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    return new Response(
      JSON.stringify({
        error: 'Internal Server Error',
        code: ErrorCode.INTERNAL_ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}

/** Maps pipeline error codes to HTTP status codes (non-streaming + context phase). */
function getStatusCodeForPipelineError(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.AUTH_FAILED:
      return 401;
    case ErrorCode.RATE_LIMIT_EXCEEDED:
      // 429. This was 401 until 2026-07-25 — it shared a fall-through case
      // with AUTH_FAILED above, which told a user who was merely
      // sending too fast that their session had expired and they should sign
      // in again (ApiError.getUserMessage() renders any 401/403 as
      // "Authentication required") — a wrong and unactionable message.
      //
      // NOTE the client must NOT fallback-retry this: the burst limiter in
      // RateLimiter is keyed on userId, not model, so every fallback model
      // hits the identical limit. chatStore excludes it by ERROR CODE rather
      // than by status, because a 429 from Azure (a model's TPM limit) is
      // genuinely worth retrying on another model — the two must stay
      // distinguishable.
      return 429;
    case ErrorCode.RATE_LIMIT_QUOTA_EXCEEDED:
      // 403, NOT 429: the two carry different advice. 429 means "you are
      // going too fast, retry in seconds"; an admin usage limit means "you
      // are out of budget until the period resets, or an administrator has
      // to change the policy". Retrying shortly does not help, so the status
      // should not suggest it.
      //
      // Retry safety no longer rests on the status: chatStore excludes both
      // rate-limit codes from fallback retry by CODE (see isRateLimitError).
      return 403;
    case ErrorCode.VALIDATION_FAILED:
      return 400;
    case ErrorCode.AGENT_UNAVAILABLE:
    case ErrorCode.MODEL_UNAVAILABLE:
      return 409;
    case ErrorCode.REQUEST_TIMEOUT:
    case ErrorCode.PIPELINE_TIMEOUT:
      return 408;
    default:
      return 500;
  }
}

/**
 * Builds the classic JSON error response for a pipeline result with errors
 * and no response. Returns null when the pipeline produced a usable
 * response (errors, if any, are logged by the caller).
 */
function buildPipelineErrorResponse(result: {
  errors?: Error[];
  response?: Response;
}): Response | null {
  if (!result.errors || result.errors.length === 0) {
    if (!result.response) {
      throw PipelineError.critical(
        ErrorCode.INTERNAL_ERROR,
        'Pipeline did not generate a response',
      );
    }
    return null;
  }

  console.error(
    '[Unified Chat] Pipeline completed with errors:',
    result.errors.map((e) => sanitizeForLog(e.message)),
  );
  if (result.response) return null;

  const firstError = result.errors[0];
  const errorCode =
    firstError instanceof PipelineError
      ? firstError.code
      : ErrorCode.INTERNAL_ERROR;

  return new Response(
    JSON.stringify({
      error: 'Internal Server Error',
      code: errorCode,
      message: firstError.message,
      details: result.errors.map((e) =>
        e instanceof PipelineError ? e.toJSON() : { message: e.message },
      ),
    }),
    {
      status: getStatusCodeForPipelineError(errorCode),
      headers: { 'Content-Type': 'application/json' },
    },
  );
}
