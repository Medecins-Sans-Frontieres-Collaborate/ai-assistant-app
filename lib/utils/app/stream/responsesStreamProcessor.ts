import {
  PendingTranscriptionInfo,
  TokenUsageMetadata,
  TranscriptMetadata,
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { UsageContext } from '@/lib/utils/app/stream/streamProcessor';

import { Citation } from '@/types/rag';

import {
  GeneratedFileRef,
  emitAgentActivity,
  emitToolCallRecord,
} from '@/lib/streamMarkers';
import type OpenAI from 'openai';

/** One native code-interpreter execution captured from the stream. */
export interface NativeCodeRun {
  code: string | null;
  logs: string | null;
  status: string;
}

/** `container_file_citation` reference captured from annotation events. */
export interface NativeContainerCitation {
  containerId: string;
  fileId: string;
  filename: string;
}

/**
 * Native code-interpreter support for the Responses path. When present,
 * code_interpreter_call events emit a live "Running code…" activity, and at
 * stream end `persistFiles` downloads/persists cited container files so the
 * emitted TOOL_CALL_RECORD carries `generated_files` — identical UI to the
 * Phase 1 sub-tool round-trip.
 */
export interface NativeCodeInterpreterHooks {
  persistFiles: (
    citations: NativeContainerCitation[],
  ) => Promise<GeneratedFileRef[]>;
}

/**
 * In-band failure report for a Responses stream. `detail` carries the raw
 * upstream error for server-side logging; the client-facing streamError
 * metadata gets a generic message only.
 */
export interface ResponsesStreamFailure {
  code: 'RESPONSES_STREAM_FAILED' | 'GENERATED_FILES_UNAVAILABLE';
  detail: string;
}

const MAX_RECORD_CODE_CHARS = 6000;
const MAX_RECORD_OUTPUT_CHARS = 4000;

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n\n[…truncated for length]`
    : text;
}

/**
 * Stream processor for the Azure OpenAI **Responses API**.
 *
 * Maps Responses stream events onto the app's wire format:
 * - `response.reasoning_summary_text.delta` → live inline `<think>` text
 *   (the same wrapper DeepSeek/Claude reasoning uses, so the client's
 *   ThinkingBlock renders it as it arrives)
 * - `response.output_text.delta` → answer text
 * - `response.completed` → token usage
 * - terminal metadata block → citations / thinking / transcript / usage
 */
export function createResponsesStreamProcessor(
  events: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
  transcript?: TranscriptMetadata,
  webSearchCitations?: Citation[],
  pendingTranscriptions?: PendingTranscriptionInfo[],
  usageContext?: UsageContext,
  codeInterpreter?: NativeCodeInterpreterHooks,
  /**
   * Called once when the stream ends with an in-band failure (upstream
   * `response.failed`/`error`, or generated files that couldn't be
   * delivered). The caller owns durable logging — console output is not
   * collected in production.
   */
  onStreamFailure?: (failure: ResponsesStreamFailure) => void,
): ReadableStream {
  return new ReadableStream({
    start: (controller) => {
      const encoder = createStreamEncoder();
      let allContent = '';
      let allThinking = '';
      let thinkingOpen = false;
      let controllerClosed = false;
      let capturedUsage: OpenAI.Responses.ResponseUsage | undefined;
      // Native code-interpreter capture
      const codeRuns: NativeCodeRun[] = [];
      const containerCitations: NativeContainerCitation[] = [];
      let runningCodeAnnounced = false;
      let codeInterpreterStartedAt: number | undefined;

      (async function () {
        try {
          // Raw upstream failure detail, when the Responses stream dies
          // mid-flight. Captured instead of thrown: the partial output has
          // already reached the client, so the stream must end CLEANLY with
          // in-band streamError metadata — controller.error() would abort
          // the socket and reach the browser as an opaque network failure,
          // which the client store treats as silently-retryable (duplicate
          // request, partial discarded).
          let upstreamFailure: string | null = null;

          try {
            streamLoop: for await (const event of events) {
              if (controllerClosed) return;

              switch (event.type) {
                case 'response.reasoning_summary_text.delta': {
                  if (!thinkingOpen) {
                    thinkingOpen = true;
                    controller.enqueue(encoder.encode('<think>\n'));
                  }
                  allThinking += event.delta;
                  controller.enqueue(encoder.encode(event.delta));
                  break;
                }
                case 'response.reasoning_summary_text.done': {
                  // Separate multi-part summaries so they don't run together.
                  if (thinkingOpen) {
                    allThinking += '\n\n';
                    controller.enqueue(encoder.encode('\n\n'));
                  }
                  break;
                }
                case 'response.output_text.delta': {
                  // Reasoning precedes the answer — close the think wrapper
                  // when the first answer token arrives.
                  if (thinkingOpen) {
                    thinkingOpen = false;
                    controller.enqueue(encoder.encode('\n</think>\n\n'));
                  }
                  allContent += event.delta;
                  controller.enqueue(encoder.encode(event.delta));
                  break;
                }
                case 'response.completed': {
                  capturedUsage = event.response.usage;
                  break;
                }
                case 'response.code_interpreter_call.in_progress': {
                  // Live loader while the sandbox spins up/executes.
                  if (!runningCodeAnnounced) {
                    runningCodeAnnounced = true;
                    codeInterpreterStartedAt = Date.now();
                    controller.enqueue(
                      encoder.encode(
                        emitAgentActivity('chat.activity.runningCode'),
                      ),
                    );
                  }
                  break;
                }
                case 'response.output_item.done': {
                  // Final shape of each code execution: source + log outputs.
                  const item = event.item;
                  if (item.type === 'code_interpreter_call') {
                    const logs = (item.outputs ?? [])
                      .filter(
                        (o): o is { type: 'logs'; logs: string } =>
                          o.type === 'logs',
                      )
                      .map((o) => o.logs)
                      .join('\n');
                    codeRuns.push({
                      code: item.code,
                      logs: logs || null,
                      status: item.status,
                    });
                  }
                  break;
                }
                case 'response.output_text.annotation.added': {
                  const annotation = event.annotation as {
                    type?: string;
                    container_id?: string;
                    file_id?: string;
                    filename?: string;
                  };
                  if (
                    annotation?.type === 'container_file_citation' &&
                    annotation.container_id &&
                    annotation.file_id
                  ) {
                    containerCitations.push({
                      containerId: annotation.container_id,
                      fileId: annotation.file_id,
                      filename: annotation.filename || 'file',
                    });
                  }
                  break;
                }
                case 'response.failed': {
                  upstreamFailure =
                    event.response.error?.message ??
                    'Response generation failed';
                  break streamLoop;
                }
                case 'error': {
                  upstreamFailure = event.message ?? 'Responses stream error';
                  break streamLoop;
                }
                default:
                  // Lifecycle/tool events we don't render (created,
                  // in_progress, output_item.*, content_part.*, …).
                  break;
              }
            }
          } catch (iterationError) {
            // The upstream connection died mid-read — same treatment as an
            // explicit failure event: finish the stream in-band.
            upstreamFailure =
              iterationError instanceof Error
                ? iterationError.message
                : String(iterationError);
          }

          if (!controllerClosed) {
            // Reasoning-only stream (stopped early) — close the wrapper so
            // the open tag never leaks as body text.
            if (thinkingOpen) {
              thinkingOpen = false;
              controller.enqueue(encoder.encode('\n</think>\n\n'));
            }

            // Native code interpreter ran: persist its container files
            // (they expire with the container) and emit the persistent
            // TOOL_CALL_RECORD the client already knows how to render.
            // Citations without completed code runs still persist — an
            // upstream failure can land between the citation event and the
            // code item's `done`, and the files may well be salvageable.
            let generatedFiles: GeneratedFileRef[] = [];
            if (
              codeInterpreter &&
              (codeRuns.length > 0 || containerCitations.length > 0)
            ) {
              try {
                generatedFiles =
                  await codeInterpreter.persistFiles(containerCitations);
              } catch (persistError) {
                console.error(
                  'Failed to persist native code-interpreter files:',
                  persistError,
                );
              }
            }
            if (codeRuns.length > 0 || generatedFiles.length > 0) {
              const code = codeRuns
                .map((r) => r.code)
                .filter(Boolean)
                .join('\n\n# --- next execution ---\n\n');
              const logs = codeRuns
                .map((r) => r.logs)
                .filter(Boolean)
                .join('\n');
              controller.enqueue(
                encoder.encode(
                  emitToolCallRecord({
                    id: `code-interpreter-${Date.now()}`,
                    name: 'code_interpreter',
                    server_label: 'Code Interpreter',
                    arguments: code
                      ? JSON.stringify({
                          code: truncate(code, MAX_RECORD_CODE_CHARS),
                        })
                      : null,
                    status: codeRuns.some((r) => r.status === 'failed')
                      ? 'failed'
                      : 'completed',
                    output: logs
                      ? truncate(logs, MAX_RECORD_OUTPUT_CHARS)
                      : null,
                    error: null,
                    ...(codeInterpreterStartedAt
                      ? { duration_ms: Date.now() - codeInterpreterStartedAt }
                      : {}),
                    ...(generatedFiles.length
                      ? { generated_files: generatedFiles }
                      : {}),
                  }),
                ),
              );
            }

            const citations =
              webSearchCitations && webSearchCitations.length > 0
                ? webSearchCitations
                : undefined;

            let transcriptMetadata: TranscriptMetadata | undefined;
            if (transcript) {
              transcriptMetadata = {
                filename: transcript.filename,
                transcript: transcript.transcript,
                processedContent: allContent,
              };
            }

            let usage: TokenUsageMetadata | undefined;
            if (usageContext && capturedUsage) {
              usage = {
                promptTokens: capturedUsage.input_tokens ?? 0,
                completionTokens: capturedUsage.output_tokens ?? 0,
                totalTokens: capturedUsage.total_tokens ?? 0,
                modelId: usageContext.modelId,
                region: usageContext.region,
                reasoningEffort: usageContext.reasoningEffort,
              };
              usageContext.onUsage?.(usage);
            }

            // In-band failure reporting. Two shapes:
            //  - the upstream stream died (`response.failed`/`error`/read
            //    error) — client-safe generic message; raw detail goes to
            //    the caller's durable log only.
            //  - the stream completed but every cited generated file failed
            //    to persist — the text promises downloads that don't exist.
            // `retry: true` marks partials not worth keeping (a missing
            // file, mid-code death, or no content at all): the client
            // auto-retries on the fallback chain instead of surfacing them.
            const codeInterpreterRan =
              runningCodeAnnounced ||
              codeRuns.length > 0 ||
              containerCitations.length > 0;
            const citedButUndelivered =
              containerCitations.length > 0 && generatedFiles.length === 0;
            let streamError:
              | { message: string; code: string; retry?: boolean }
              | undefined;
            if (upstreamFailure !== null) {
              console.error(
                'Responses stream failed upstream:',
                upstreamFailure,
              );
              onStreamFailure?.({
                code: 'RESPONSES_STREAM_FAILED',
                detail: upstreamFailure,
              });
              const retry =
                citedButUndelivered ||
                (codeInterpreterRan && generatedFiles.length === 0) ||
                allContent.trim().length === 0;
              streamError = {
                code: 'RESPONSES_STREAM_FAILED',
                message:
                  'The model stopped before finishing this response.' +
                  (retry ? '' : ' The partial answer is shown below.'),
                ...(retry ? { retry: true } : {}),
              };
            } else if (citedButUndelivered) {
              onStreamFailure?.({
                code: 'GENERATED_FILES_UNAVAILABLE',
                detail: `${containerCitations.length} cited container file(s), 0 persisted`,
              });
              streamError = {
                code: 'GENERATED_FILES_UNAVAILABLE',
                message:
                  'The generated file could not be retrieved from the sandbox.',
                retry: true,
              };
            }

            appendMetadataToStream(controller, {
              citations,
              thinking: allThinking.trim() || undefined,
              transcript: transcriptMetadata,
              pendingTranscriptions,
              usage,
              streamError,
            });
          }

          if (!controllerClosed) {
            controllerClosed = true;
            controller.close();
          }
        } catch (error) {
          console.error('Responses stream processing error:', error);
          if (!controllerClosed) {
            controllerClosed = true;
            controller.error(error);
          }
        }
      })();
    },
  });
}
