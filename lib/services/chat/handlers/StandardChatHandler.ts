import {
  MetricsService,
  getAzureMonitorLogger,
} from '@/lib/services/observability';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';

import { StandardChatService } from '../StandardChatService';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { SpanStatusCode, trace } from '@opentelemetry/api';

/** Union of all possible message content types */
type MessageContent =
  | TextMessageContent
  | ImageMessageContent
  | FileMessageContent;

/**
 * Content types that should be passed through to the LLM API.
 * Excludes 'file_url' which is an internal type for file references.
 */
const ALLOWED_CONTENT_TYPES = ['text', 'image_url'];

/**
 * StandardChatHandler executes the final chat request.
 *
 * Responsibilities:
 * - Takes processed content and enriched messages
 * - Calls the appropriate chat service (standard or agent)
 * - Returns the Response object
 *
 * Modifies context:
 * - context.response (the final HTTP Response)
 *
 * This is always the LAST stage in the pipeline.
 */
export class StandardChatHandler extends BasePipelineStage {
  readonly name = 'StandardChatHandler';
  private tracer = trace.getTracer('standard-chat-handler');

  constructor(private standardChatService: StandardChatService) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    // Always run unless agent execution is specified
    return context.executionStrategy !== 'agent';
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const startTime = Date.now();

    return await this.tracer.startActiveSpan(
      'chat.execute',
      {
        attributes: {
          'chat.model': context.modelId,
          'chat.message_count': context.messages.length,
          'chat.stream': context.stream,
          'chat.has_rag': !!context.botId,
          'chat.has_files': context.hasFiles,
          'chat.has_images': context.hasImages,
          'user.id': context.user.id,
          'user.email': context.user.mail || 'unknown',
          'user.department': context.user.department || 'unknown',
          'user.company': context.user.companyName || 'unknown',
          'user.job_title': context.user.jobTitle || 'unknown',
        },
      },
      async (span) => {
        try {
          // Extract transcript metadata if available (for audio/video transcriptions)
          const transcript = context.processedContent?.transcripts?.[0]
            ? {
                filename: context.processedContent.transcripts[0].filename,
                transcript: context.processedContent.transcripts[0].transcript,
                processedContent: undefined, // Will be filled by LLM response
              }
            : undefined;

          // Check if we have a transcript with no user message (just transcription request)
          if (transcript) {
            const lastMessage = context.messages[context.messages.length - 1];
            let userText = '';

            // Extract user text from message content
            if (typeof lastMessage.content === 'string') {
              userText = lastMessage.content.trim();
            } else if (Array.isArray(lastMessage.content)) {
              const textContent = lastMessage.content.find(
                (c) => c.type === 'text',
              );
              if (textContent && 'text' in textContent) {
                userText = textContent.text.trim();
              }
            }

            // If user text is empty or just a filename pattern, skip LLM and return transcription only
            const isEmptyOrFilename =
              !userText ||
              /^(?:\[Audio\/Video:\s*[^\]]+\]|\[[^\]]+\])?$/i.test(userText);

            if (isEmptyOrFilename) {
              console.log(
                '[StandardChatHandler] No user message detected, returning transcription only',
              );

              // Create a minimal response that just returns the transcript
              const encoder = new TextEncoder();
              const pendingTranscriptions =
                context.processedContent?.pendingTranscriptions;

              // Get jobId from pending transcriptions for tracking
              const pendingJobId =
                pendingTranscriptions && pendingTranscriptions.length > 0
                  ? pendingTranscriptions[0].jobId
                  : undefined;

              const stream = new ReadableStream({
                start(controller) {
                  // Send metadata with transcript only (no LLM processing)
                  // Include pendingTranscriptions for async batch jobs
                  // Include jobId in transcript metadata for reliable message tracking
                  const metadata: {
                    transcript: {
                      filename: string;
                      transcript: string;
                      processedContent: undefined;
                      jobId?: string;
                    };
                    pendingTranscriptions?: typeof pendingTranscriptions;
                  } = {
                    transcript: {
                      filename: transcript.filename,
                      transcript: transcript.transcript,
                      processedContent: undefined, // No LLM processing
                      jobId: pendingJobId, // For reliable message update tracking
                    },
                  };
                  if (
                    pendingTranscriptions &&
                    pendingTranscriptions.length > 0
                  ) {
                    metadata.pendingTranscriptions = pendingTranscriptions;
                  }

                  // Send placeholder content FIRST so it becomes the message content
                  // This allows updateMessageWithTranscript to find and replace it later
                  const placeholderContent = transcript.transcript;
                  controller.enqueue(encoder.encode(placeholderContent));

                  // Then send metadata
                  const metadataStr = `\n\n<<<METADATA_START>>>${JSON.stringify(metadata)}<<<METADATA_END>>>`;
                  controller.enqueue(encoder.encode(metadataStr));
                  controller.close();
                },
              });

              return {
                ...context,
                response: new Response(stream, {
                  headers: {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-cache',
                    Connection: 'keep-alive',
                  },
                }),
              };
            }
          }

          // Check if file processing failed and we should return an error response
          const fileProcessingFailed =
            context.processedContent?.metadata?.fileProcessingFailed;
          if (
            fileProcessingFailed &&
            context.errors &&
            context.errors.length > 0
          ) {
            // Log the actual error for debugging (server-side only)
            const fileError = context.errors.find(
              (e) =>
                e.message.includes('transcribe') ||
                e.message.includes('Audio extraction') ||
                e.message.includes('Cannot transcribe') ||
                e.message.includes('does not contain an audio track') ||
                e.message.includes('file'),
            );

            if (fileError) {
              console.error(
                '[StandardChatHandler] File processing failed:',
                fileError.message,
              );
            }

            console.log(
              '[StandardChatHandler] File processing failed, returning error response',
            );

            const encoder = new TextEncoder();
            // Map known error patterns to user-friendly messages
            let errorMessage: string;
            if (
              fileError?.message.includes('does not contain an audio track')
            ) {
              errorMessage =
                'We were unable to detect an audio track in the provided video file. You can try uploading a video with audio or an audio file directly.';
            } else if (fileError?.message.includes('FFmpeg is not available')) {
              errorMessage =
                "We're currently unable to process video files. You can try uploading an audio file instead.";
            } else {
              // Default generic message for unknown errors
              errorMessage =
                'We were unable to process the uploaded file. You can try uploading the file again or using a different file format.';
            }

            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(errorMessage));
                controller.close();
              },
            });

            return {
              ...context,
              response: new Response(stream, {
                headers: {
                  'Content-Type': 'text/plain; charset=utf-8',
                  'Cache-Control': 'no-cache',
                  Connection: 'keep-alive',
                },
              }),
            };
          }

          // Build final messages from enriched messages or processed content
          const messagesToSend = this.buildFinalMessages(context);

          console.log(
            '[StandardChatHandler] Final message count:',
            messagesToSend.length,
          );
          console.log(
            '[StandardChatHandler] Model:',
            sanitizeForLog(context.modelId),
          );
          console.log(
            '[StandardChatHandler] Stream:',
            sanitizeForLog(context.stream),
          );

          // Check if RAG is enabled
          const ragConfig = context.processedContent?.metadata?.ragConfig;

          // Extract citations from web search results
          const citations = context.processedContent?.metadata?.citations;

          if (transcript) {
            console.log(
              '[StandardChatHandler] Including transcript metadata:',
              sanitizeForLog(transcript.filename),
            );
          }

          if (citations) {
            console.log(
              '[StandardChatHandler] Including search citations:',
              sanitizeForLog(citations.length),
              'citations',
            );
            console.log(
              '[StandardChatHandler] Citation URLs:',
              citations.map((c: { url?: string }) => c.url),
            );
            console.log(
              '[StandardChatHandler] Citation titles:',
              citations.map((c: { title?: string }) => c.title),
            );
          } else {
            console.log(
              '[StandardChatHandler] No citations found in context.processedContent.metadata',
            );
          }

          // Execute chat
          const response = await this.standardChatService.handleChat({
            messages: messagesToSend,
            model: context.model,
            user: context.user,
            systemPrompt: context.systemPrompt,
            temperature: context.temperature,
            stream: context.stream,
            reasoningEffort: context.reasoningEffort,
            verbosity: context.verbosity,
            botId: ragConfig?.botId,
            transcript,
            citations,
            tone: context.tone,
            pendingTranscriptions:
              context.processedContent?.pendingTranscriptions,
            streamingSpeed: context.streamingSpeed,
          });

          // Record metrics
          const duration = Date.now() - startTime;
          MetricsService.recordRequest(ragConfig ? 'rag' : 'chat', duration, {
            user: context.user,
            success: true,
            model: context.modelId,
            botId: context.botId,
          });

          // Log to Azure Monitor (fire-and-forget)
          const logger = getAzureMonitorLogger();
          void logger.logChatCompletion({
            user: context.user,
            model: context.modelId,
            messageCount: messagesToSend.length,
            temperature: context.temperature,
            duration,
            hasFiles: context.hasFiles || false,
            hasImages: context.hasImages || false,
            hasRAG: !!ragConfig,
            botId: context.botId,
            reasoningEffort: context.reasoningEffort,
          });

          // TODO: Extract token usage from response headers/metadata and record
          // MetricsService.recordTokenUsage({ total: tokens }, { user, model, operation: 'chat' });

          span.setAttribute('chat.final_message_count', messagesToSend.length);
          span.setAttribute('chat.duration_ms', duration);
          span.setStatus({ code: SpanStatusCode.OK });

          return {
            ...context,
            response,
          };
        } catch (error) {
          // Record error metrics
          MetricsService.recordError('chat_execution_failed', {
            user: context.user,
            operation: 'chat',
            model: context.modelId,
            message: error instanceof Error ? error.message : 'Unknown error',
          });

          // Log error to Azure Monitor (fire-and-forget)
          const logger = getAzureMonitorLogger();
          void logger.logError({
            user: context.user,
            errorCode: 'CHAT_EXECUTION_FAILED',
            errorMessage:
              error instanceof Error ? error.message : 'Unknown error',
            stackTrace: error instanceof Error ? error.stack : undefined,
            operation: 'chat',
            model: context.modelId,
            botId: context.botId,
          });

          // Check if RAG was being used (need to redeclare since it's outside span scope)
          const ragConfigInError =
            context.processedContent?.metadata?.ragConfig;
          MetricsService.recordRequest(
            ragConfigInError ? 'rag' : 'chat',
            Date.now() - startTime,
            {
              user: context.user,
              success: false,
              model: context.modelId,
              botId: context.botId,
            },
          );
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Builds the final messages array from processed content and enrichments.
   *
   * Priority:
   * 1. Use enrichedMessages if available (from enrichers)
   * 2. Use processed content + original messages (from processors)
   * 3. Use original messages (if no processing)
   */
  private buildFinalMessages(context: ChatContext): Message[] {
    // If enrichers modified messages, use those (but still sanitize)
    if (context.enrichedMessages) {
      return this.stripUnsupportedContentTypes(context.enrichedMessages);
    }

    // If we have processed content, inject it into messages
    if (context.processedContent) {
      const { fileSummaries, inlineFiles, transcripts, images } =
        context.processedContent;

      // Start with original messages
      let messages = [...context.messages];

      // Add processed content to the last message
      const lastMessage = messages[messages.length - 1];

      if (Array.isArray(lastMessage.content)) {
        const enrichedContent = [...lastMessage.content];

        // Collect all text parts (existing + processed content)
        const textParts: string[] = [];

        // Extract existing text content
        enrichedContent.forEach((c) => {
          if (c.type === 'text' && c.text) {
            textParts.push(c.text);
          }
        });

        // Add file summaries (extracted content from large files)
        if (fileSummaries && fileSummaries.length > 0) {
          const summaryText = fileSummaries
            .map((f) => `[Document summary: ${f.filename}]\n${f.summary}`)
            .join('\n\n');
          textParts.push(summaryText);
        }

        // Add inline file content (small files included as-is)
        if (inlineFiles && inlineFiles.length > 0) {
          const inlineText = inlineFiles
            .map((f) => '```' + f.filename + '\n' + f.content + '\n```')
            .join('\n\n');
          textParts.push(inlineText);
        }

        // Add transcripts
        if (transcripts && transcripts.length > 0) {
          const transcriptText = transcripts
            .map((t) => `[Audio/Video: ${t.filename}]\n${t.transcript}`)
            .join('\n\n');
          textParts.push(transcriptText);
        }

        // Filter out text and file_url content (will be replaced with merged text)
        const nonTextContent = enrichedContent.filter(
          (c) => c.type !== 'file_url' && c.type !== 'text',
        );

        // Replace image URLs with converted base64 from context.processedContent.images
        // The processors convert blob storage URLs to base64 data URLs for LLM consumption
        if (images && images.length > 0) {
          let imageIndex = 0;
          for (const item of nonTextContent) {
            if (
              item.type === 'image_url' &&
              'image_url' in item &&
              imageIndex < images.length
            ) {
              // Replace with converted base64 URL
              (
                item as {
                  type: 'image_url';
                  image_url: { url: string; detail?: string };
                }
              ).image_url.url = images[imageIndex].url;
              (
                item as {
                  type: 'image_url';
                  image_url: { url: string; detail?: string };
                }
              ).image_url.detail = images[imageIndex].detail;
              imageIndex++;
            }
          }
        }

        // Build final content array
        const finalContent: typeof enrichedContent = [];

        // Add merged text content as first item
        if (textParts.length > 0) {
          finalContent.push({
            type: 'text',
            text: textParts.join('\n\n'),
          });
        }

        // Add non-text content (e.g., images with base64 URLs)
        finalContent.push(...nonTextContent);

        // Replace last message with enriched content
        messages[messages.length - 1] = {
          ...lastMessage,
          content:
            finalContent.length === 1 && finalContent[0].type === 'text'
              ? finalContent[0].text // Convert to string if only text
              : finalContent,
        };
      }

      // Sanitize all messages before returning (defensive measure)
      return this.stripUnsupportedContentTypes(messages);
    }

    // No processing, return original messages with file_url filtered out
    return this.stripUnsupportedContentTypes(context.messages);
  }

  /**
   * Strips content types not supported by LLM APIs from messages.
   * This is a defensive measure to ensure 'file_url' and other internal
   * content types never reach the API even if upstream processing fails.
   *
   * @param messages - The messages to sanitize
   * @returns Messages with only API-supported content types
   */
  private stripUnsupportedContentTypes(messages: Message[]): Message[] {
    return messages.map((message) => {
      // String content is always valid
      if (typeof message.content === 'string') {
        return message;
      }

      // Non-array content, pass through
      if (!Array.isArray(message.content)) {
        return message;
      }

      // Filter out unsupported content types
      const filteredContent = message.content.filter((c: MessageContent) =>
        ALLOWED_CONTENT_TYPES.includes(c.type),
      );

      // If all content was filtered out, add placeholder text
      if (filteredContent.length === 0) {
        console.warn(
          '[StandardChatHandler] All content was filtered out, adding placeholder',
        );
        return {
          ...message,
          content: '[File content could not be processed]',
        };
      }

      // If only one text item remains, convert to string for simplicity
      if (
        filteredContent.length === 1 &&
        filteredContent[0].type === 'text' &&
        'text' in filteredContent[0]
      ) {
        return {
          ...message,
          content: (filteredContent[0] as TextMessageContent).text,
        };
      }

      return {
        ...message,
        content: filteredContent,
      };
    });
  }
}
