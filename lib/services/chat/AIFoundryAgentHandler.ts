import { Session } from 'next-auth';

import {
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { getMessagesToSend } from '@/lib/utils/server/chat/chat';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktoken/tiktokenCache';

import { AgentCapabilities } from '@/types/agent';
import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import {
  CodeInterpreterMetadata,
  CodeInterpreterOutput,
} from '@/types/codeInterpreter';
import { OpenAIModel } from '@/types/openai';

import { MetricsService } from '../observability/MetricsService';

import { env } from '@/config/environment';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Handles Azure AI Foundry Agent-based chat completions.
 *
 * Supports multiple agent capabilities:
 * - Bing grounding (default for agents)
 * - Code Interpreter (when enabled via agentCapabilities)
 *
 * Package structure:
 * - Uses @azure/ai-agents (AgentsClient) for streaming support
 *
 * API structure:
 * - client.threads.create() - creates a new thread
 * - client.messages.create(threadId, role, content) - adds a message
 * - client.runs.create(threadId, agentId) - returns run object with stream() method (DO NOT await!)
 * - run.stream() - returns async iterator of streaming events
 */
export class AIFoundryAgentHandler {
  private tracer = trace.getTracer('ai-foundry-agent-handler');

  constructor() {}

  /**
   * Handles chat completion using Azure AI Foundry Agents.
   *
   * This method handles all agent capabilities uniformly:
   * - Standard agents with Bing grounding
   * - Agents with Code Interpreter enabled (Python execution)
   *
   * The behavior is determined by the `capabilities` parameter:
   * - If `capabilities.codeInterpreter.enabled`: attachments are added, Code Interpreter events are handled
   * - Otherwise: standard agent execution with Bing grounding
   *
   * @param modelId - The model ID being used
   * @param modelConfig - Model configuration including agentId
   * @param messages - Conversation messages
   * @param temperature - Temperature setting
   * @param user - Authenticated user
   * @param botId - Optional bot/knowledge base ID
   * @param threadId - Optional existing thread ID for conversation continuity
   * @param capabilities - Optional agent capabilities (Code Interpreter, etc.)
   */
  async handleAgentChat(
    modelId: string,
    modelConfig: OpenAIModel,
    messages: Message[],
    temperature: number,
    user: Session['user'],
    botId: string | undefined,
    threadId?: string,
    capabilities?: AgentCapabilities,
  ): Promise<Response> {
    const startTime = Date.now();
    const hasCodeInterpreter = capabilities?.codeInterpreter?.enabled || false;
    const uploadedFiles = capabilities?.codeInterpreter?.uploadedFiles || [];

    // Create OpenTelemetry span for tracing
    return await this.tracer.startActiveSpan(
      hasCodeInterpreter
        ? 'ai_foundry_agent.code_interpreter'
        : 'ai_foundry_agent.chat',
      {
        attributes: {
          'agent.id': modelConfig.agentId || 'unknown',
          'agent.model': modelId,
          'agent.type': hasCodeInterpreter ? 'code_interpreter' : 'standard',
          'message.count': messages.length,
          'message.temperature': temperature,
          'user.id': user.id,
          'user.email': user.mail || 'unknown',
          'user.department': user.department || 'unknown',
          'user.company': user.companyName || 'unknown',
          'user.job_title': user.jobTitle || 'unknown',
          'bot.id': botId || 'none',
          'thread.id': threadId || 'new',
          'thread.is_new': !threadId,
          'files.count': uploadedFiles.length,
        },
      },
      async (span) => {
        try {
          // Use Azure AI Agents SDK for streaming support
          const aiAgents = await import('@azure/ai-agents');
          const { DefaultAzureCredential } = await import('@azure/identity');

          // AI Foundry uses a separate project endpoint (services.ai.azure.com)
          const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;

          // Use Code Interpreter agent ID if available and capability is enabled
          const agentId = hasCodeInterpreter
            ? modelConfig.codeInterpreterAgentId || modelConfig.agentId
            : modelConfig.agentId;

          if (!endpoint || !agentId) {
            throw new Error(
              'Azure AI Foundry endpoint or Agent ID not configured',
            );
          }

          const client = new aiAgents.AgentsClient(
            endpoint,
            new DefaultAzureCredential(),
          );

          // Process messages to inject artifactContext and handle token limits
          const encoding = await getGlobalTiktoken();
          const processedMessages = await getMessagesToSend(
            messages,
            encoding,
            0, // No system prompt for agents (they have built-in instructions)
            modelConfig.tokenLimit,
            user,
          );

          console.log('[AIFoundryAgentHandler] Messages processed:', {
            originalCount: messages.length,
            processedCount: processedMessages.length,
            hasArtifactContext: messages.some((m) => m.artifactContext),
            hasCodeInterpreter,
            fileCount: uploadedFiles.length,
          });

          // Create a thread and run for this conversation with streaming
          const lastMessage = processedMessages[processedMessages.length - 1];

          let thread;
          let isNewThread = false;

          try {
            if (threadId) {
              // For existing thread, just reuse it
              // The thread already has all previous messages persisted
              thread = { id: threadId };
            } else {
              // Create a new thread for the first message
              thread = await client.threads.create();
              isNewThread = true;
            }
          } catch (threadError) {
            console.error('Error with thread:', threadError);
            throw threadError;
          }

          try {
            // Prepare message content based on capabilities
            if (hasCodeInterpreter) {
              // For Code Interpreter: send text-only message with file attachments
              const messageContent = this.extractTextContent(lastMessage);

              // Create attachments from uploaded files
              const attachments = uploadedFiles.map((file) => ({
                file_id: file.id,
                tools: [{ type: 'code_interpreter' as const }],
              }));

              console.log(
                '[AIFoundryAgentHandler] Creating message with attachments:',
                {
                  threadId: thread.id,
                  fileCount: attachments.length,
                  fileIds: uploadedFiles.map((f) => f.id),
                },
              );

              // Create message with attachments
              await client.messages.create(thread.id, 'user', messageContent, {
                attachments,
              });
            } else {
              // For standard agents: handle multimodal content
              const messageContent = this.convertToAgentFormat(lastMessage);
              await client.messages.create(thread.id, 'user', messageContent);
            }
          } catch (messageError) {
            console.error('Error creating message:', messageError);
            console.error(
              'Full error object:',
              JSON.stringify(messageError, null, 2),
            );
            throw messageError;
          }

          // Create a run and get the stream
          let streamEventMessages;
          try {
            // Debug logging
            console.log('Creating run with:', {
              threadId: thread.id,
              agentId: String(agentId),
              endpoint: endpoint,
            });

            // Check if client.runs exists
            if (!client.runs) {
              console.error(
                'client.runs is undefined. Client structure:',
                Object.keys(client),
              );
              throw new Error(
                'AgentsClient does not have runs property - check SDK version',
              );
            }

            // The Azure AI Agents SDK expects the agentId as the second parameter
            // and returns an object with a stream() method (DO NOT await the create call!)
            const run = client.runs.create(thread.id, String(agentId));

            // Call stream() on the run object
            streamEventMessages = await run.stream();
          } catch (streamError: any) {
            console.error('Error creating stream:', streamError);
            if (streamError instanceof Error) {
              console.error('Error stack:', streamError.stack);
            }
            // Log the full error details including response body if available
            if (streamError.response) {
              console.error(
                'Error response status:',
                streamError.response.status,
              );
              console.error('Error response body:', streamError.response.body);
            }
            if (streamError.details) {
              console.error(
                'Error details:',
                JSON.stringify(streamError.details, null, 2),
              );
            }
            throw streamError;
          }

          // Create the response stream
          const stream = hasCodeInterpreter
            ? this.createCodeInterpreterStream(
                streamEventMessages,
                thread,
                isNewThread,
                uploadedFiles,
                startTime,
              )
            : this.createStandardAgentStream(
                streamEventMessages,
                thread,
                isNewThread,
              );

          // Record metrics
          const duration = Date.now() - startTime;
          const metricType = hasCodeInterpreter ? 'code_interpreter' : 'agent';
          MetricsService.recordRequest(metricType, duration, {
            user,
            success: true,
            model: modelId,
            botId,
          });

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('response.stream', true);
          span.setAttribute('agent.duration_ms', duration);
          if (hasCodeInterpreter) {
            span.setAttribute(
              'code_interpreter.files_uploaded',
              uploadedFiles.length,
            );
          }

          return new Response(stream, {
            headers: STREAMING_RESPONSE_HEADERS,
          });
        } catch (error) {
          // Record exception in span
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });

          // Record error metrics
          const errorType = hasCodeInterpreter
            ? 'code_interpreter_failed'
            : 'agent_execution_failed';
          MetricsService.recordError(errorType, {
            user,
            operation: hasCodeInterpreter ? 'code_interpreter' : 'agent',
            model: modelId,
            message: error instanceof Error ? error.message : 'Unknown error',
          });

          const metricType = hasCodeInterpreter ? 'code_interpreter' : 'agent';
          MetricsService.recordRequest(metricType, Date.now() - startTime, {
            user,
            success: false,
            model: modelId,
            botId,
          });

          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Extracts text content from a message for Code Interpreter.
   */
  private extractTextContent(message: Message): string {
    if (typeof message.content === 'string') {
      return message.content;
    } else if (
      typeof message.content === 'object' &&
      'text' in message.content
    ) {
      return (message.content as TextMessageContent).text;
    } else if (Array.isArray(message.content)) {
      for (const section of message.content) {
        if (section.type === 'text') {
          return section.text;
        }
      }
    }
    return String(message.content);
  }

  /**
   * Converts message content to Azure SDK format for standard agents.
   */
  private convertToAgentFormat(
    message: Message,
  ):
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; imageUrl: { url: string; detail: string } }
      > {
    if (typeof message.content === 'string') {
      return message.content;
    } else if (Array.isArray(message.content)) {
      // Multimodal content - convert to Azure SDK format
      return message.content.map(
        (
          item: TextMessageContent | ImageMessageContent | FileMessageContent,
        ) => {
          if (item.type === 'text') {
            return { type: 'text', text: item.text };
          } else if (item.type === 'image_url') {
            // Convert image_url to imageUrl (Azure SDK uses camelCase)
            return {
              type: 'image_url',
              imageUrl: {
                url: item.image_url.url,
                detail: item.image_url.detail || 'auto',
              },
            };
          } else if (item.type === 'file_url') {
            // For non-image files, add as text with context
            // Note: Azure AI Agents SDK handles files via file search tool
            return {
              type: 'text',
              text: `[File attached: ${item.originalFilename || 'file'}]`,
            };
          }
          return item as { type: 'text'; text: string };
        },
      );
    } else if (
      typeof message.content === 'object' &&
      'text' in message.content
    ) {
      // Single TextMessageContent object
      return (message.content as TextMessageContent).text;
    }
    // Fallback
    return String(message.content);
  }

  /**
   * Creates a ReadableStream for standard agent responses (Bing grounding).
   */
  private createStandardAgentStream(
    streamEventMessages: AsyncIterable<any>,
    thread: { id: string },
    isNewThread: boolean,
  ): ReadableStream {
    return new ReadableStream({
      async start(controller) {
        const encoder = createStreamEncoder();
        let citations: Array<{
          number: number;
          title: string;
          url: string;
          date: string;
        }> = [];
        let citationIndex = 1;
        const citationMap = new Map<string, number>();

        // markerBuffer: Accumulates text to handle citation markers split across chunks
        let markerBuffer = '';

        try {
          for await (const eventMessage of streamEventMessages) {
            // Handle different event types
            if (eventMessage.event === 'thread.message.delta') {
              const messageData = eventMessage.data as {
                delta?: {
                  content?: Array<{
                    type: string;
                    text?: { value: string };
                  }>;
                };
              };
              if (
                messageData?.delta?.content &&
                Array.isArray(messageData.delta.content)
              ) {
                messageData.delta.content.forEach(
                  (contentPart: { type: string; text?: { value: string } }) => {
                    if (
                      contentPart.type === 'text' &&
                      contentPart.text?.value
                    ) {
                      const textChunk = contentPart.text.value;

                      // Stage 1: Accumulate text in marker buffer
                      markerBuffer += textChunk;

                      // Stage 2: Process complete citation markers in accumulated buffer
                      //
                      // Azure agents return citations in two formats:
                      // - Short: 【3:0†source】 (just the word "source")
                      // - Long:  【3:0†Title†URL】 (embedded title and URL)
                      //
                      // Regex breakdown: /【(\d+):(\d+)†[^】]+】/g
                      // - 【        : Opening bracket (Chinese left lenticular bracket)
                      // - (\d+)    : First number (source index)
                      // - :        : Literal colon
                      // - (\d+)    : Second number (sub-index)
                      // - †        : Dagger symbol separator
                      // - [^】]+   : Any characters except closing bracket
                      // - 】       : Closing bracket (Chinese right lenticular bracket)
                      //
                      // Each unique marker gets a sequential number [1], [2], etc.
                      const processedBuffer = markerBuffer.replace(
                        /【(\d+):(\d+)†[^】]+】/g,
                        (match: string) => {
                          if (!citationMap.has(match)) {
                            citationMap.set(match, citationIndex);
                            citationIndex++;
                          }
                          return `[${citationMap.get(match)}]`;
                        },
                      );

                      // Stage 3: Check for incomplete markers at end of buffer
                      // If there's an opening bracket without a closing one, keep it
                      const lastOpenBracket = processedBuffer.lastIndexOf('【');
                      const lastCloseBracket =
                        processedBuffer.lastIndexOf('】');

                      if (lastOpenBracket > lastCloseBracket) {
                        // Incomplete marker at end - keep it in buffer, send the rest
                        const completeText = processedBuffer.slice(
                          0,
                          lastOpenBracket,
                        );
                        if (completeText) {
                          controller.enqueue(encoder.encode(completeText));
                        }
                        markerBuffer = processedBuffer.slice(lastOpenBracket);
                      } else {
                        // All markers complete - send everything
                        controller.enqueue(encoder.encode(processedBuffer));
                        markerBuffer = '';
                      }
                    }
                  },
                );
              }
            } else if (eventMessage.event === 'thread.message.completed') {
              // Extract citations from annotations
              const messageData = eventMessage.data as {
                content?: Array<{
                  text?: {
                    annotations?: Array<{
                      type: string;
                      text?: string;
                      urlCitation?: { title?: string; url?: string };
                    }>;
                  };
                }>;
              };
              if (messageData?.content?.[0]?.text?.annotations) {
                const annotations = messageData.content[0].text.annotations;

                // Build a map from citation marker to annotation
                const markerToAnnotation = new Map<
                  string,
                  { title?: string; url?: string }
                >();
                annotations.forEach(
                  (annotation: {
                    type: string;
                    text?: string;
                    urlCitation?: { title?: string; url?: string };
                  }) => {
                    if (
                      annotation.type === 'url_citation' &&
                      annotation.text &&
                      annotation.urlCitation
                    ) {
                      markerToAnnotation.set(
                        annotation.text,
                        annotation.urlCitation,
                      );
                    }
                  },
                );

                // Build citations list based on citationMap order
                // This ensures inline numbers match the citation list
                citations = [];
                for (const [marker, number] of citationMap.entries()) {
                  const urlCitation = markerToAnnotation.get(marker);
                  // Always add citation even if annotation is missing
                  citations.push({
                    number: number,
                    title: urlCitation?.title || `Source ${number}`,
                    url: urlCitation?.url || '',
                    date: '',
                  });

                  if (!urlCitation) {
                    console.warn(
                      `[AIFoundryAgentHandler] No annotation found for marker ${marker}, using placeholder`,
                    );
                  }
                }
              }
            } else if (eventMessage.event === 'thread.run.completed') {
              // Flush any remaining marker buffer
              if (markerBuffer) {
                controller.enqueue(encoder.encode(markerBuffer));
                markerBuffer = '';
              }

              // Append metadata at the very end using utility function
              // No need to deduplicate - citationMap already ensured uniqueness
              appendMetadataToStream(controller, {
                citations: citations.length > 0 ? citations : undefined,
                threadId: isNewThread ? thread.id : undefined,
              });
            } else if (eventMessage.event === 'error') {
              controller.error(
                new Error(`Agent error: ${JSON.stringify(eventMessage.data)}`),
              );
            } else if (eventMessage.event === 'done') {
              // Stop the smooth streaming loop and close
              controller.close();
            }
          }
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }

  /**
   * Creates a ReadableStream for Code Interpreter responses.
   *
   * Handles additional event types:
   * - thread.run.step.delta: Python code input and execution outputs
   * - File annotations in thread.message.completed
   */
  private createCodeInterpreterStream(
    streamEventMessages: AsyncIterable<any>,
    thread: { id: string },
    isNewThread: boolean,
    uploadedFiles: Array<{ id: string; filename: string }>,
    startTime: number,
  ): ReadableStream {
    return new ReadableStream({
      async start(controller) {
        const encoder = createStreamEncoder();
        let markerBuffer = '';
        let currentCode = '';
        const outputs: CodeInterpreterOutput[] = [];

        // Track Code Interpreter metadata
        const codeInterpreterMetadata: CodeInterpreterMetadata = {
          executionPhase: 'executing',
          outputs: [],
          uploadedFiles: uploadedFiles.map((f) => ({
            id: f.id,
            filename: f.filename,
            purpose: 'assistants' as const,
          })),
          code: undefined,
          error: undefined,
        };

        try {
          for await (const eventMessage of streamEventMessages) {
            // Handle text content streaming
            if (eventMessage.event === 'thread.message.delta') {
              const messageData = eventMessage.data as {
                delta?: {
                  content?: Array<{
                    type: string;
                    text?: { value: string };
                  }>;
                };
              };

              if (messageData?.delta?.content) {
                for (const contentPart of messageData.delta.content) {
                  if (contentPart.type === 'text' && contentPart.text?.value) {
                    controller.enqueue(encoder.encode(contentPart.text.value));
                  }
                }
              }
            }

            // Handle Code Interpreter step events
            else if (eventMessage.event === 'thread.run.step.delta') {
              const stepData = eventMessage.data as {
                delta?: {
                  step_details?: {
                    tool_calls?: Array<{
                      type: string;
                      code_interpreter?: {
                        input?: string;
                        outputs?: Array<{
                          type: string;
                          logs?: string;
                          image?: {
                            file_id: string;
                          };
                        }>;
                      };
                    }>;
                  };
                };
              };

              const toolCalls = stepData?.delta?.step_details?.tool_calls;
              if (toolCalls) {
                for (const toolCall of toolCalls) {
                  if (toolCall.type === 'code_interpreter') {
                    const ci = toolCall.code_interpreter;

                    // Stream Python code input
                    if (ci?.input) {
                      currentCode += ci.input;

                      // Send code block indicator for UI rendering
                      controller.enqueue(
                        encoder.encode(`\n\`\`\`python\n${ci.input}`),
                      );
                    }

                    // Handle outputs
                    if (ci?.outputs) {
                      for (const output of ci.outputs) {
                        if (output.type === 'logs' && output.logs) {
                          // Execution logs (print statements, etc.)
                          outputs.push({
                            type: 'logs',
                            content: output.logs,
                          });

                          // Close code block if open and show logs
                          controller.enqueue(
                            encoder.encode(
                              `\n\`\`\`\n\n**Output:**\n\`\`\`\n${output.logs}\n\`\`\`\n`,
                            ),
                          );
                        } else if (
                          output.type === 'image' &&
                          output.image?.file_id
                        ) {
                          // Generated image (chart, plot, etc.)
                          outputs.push({
                            type: 'image',
                            fileId: output.image.file_id,
                            mimeType: 'image/png',
                          });

                          // Add placeholder for image - client will render
                          controller.enqueue(
                            encoder.encode(
                              `\n\n![Generated Image](code_interpreter:${output.image.file_id})\n`,
                            ),
                          );
                        }
                      }
                    }
                  }
                }
              }
            }

            // Handle message completion - extract file annotations
            else if (eventMessage.event === 'thread.message.completed') {
              const messageData = eventMessage.data as {
                content?: Array<{
                  text?: {
                    annotations?: Array<{
                      type: string;
                      text?: string;
                      file_path?: {
                        file_id: string;
                      };
                    }>;
                  };
                }>;
              };

              // Extract container_file_citation annotations
              const annotations = messageData?.content?.[0]?.text?.annotations;
              if (annotations) {
                for (const annotation of annotations) {
                  if (
                    annotation.type === 'file_path' &&
                    annotation.file_path?.file_id
                  ) {
                    outputs.push({
                      type: 'file',
                      fileId: annotation.file_path.file_id,
                      filename: annotation.text || 'generated_file',
                    });
                  }
                }
              }

              codeInterpreterMetadata.executionPhase = 'completed';
              codeInterpreterMetadata.code = currentCode || undefined;
              codeInterpreterMetadata.outputs = outputs;
            }

            // Handle run completion
            else if (eventMessage.event === 'thread.run.completed') {
              // Flush any remaining buffer
              if (markerBuffer) {
                controller.enqueue(encoder.encode(markerBuffer));
              }

              // Update metadata
              codeInterpreterMetadata.executionPhase = 'completed';
              codeInterpreterMetadata.durationMs = Date.now() - startTime;

              // Append metadata
              appendMetadataToStream(controller, {
                threadId: isNewThread ? thread.id : undefined,
                codeInterpreter: codeInterpreterMetadata,
              });
            }

            // Handle errors
            else if (eventMessage.event === 'error') {
              codeInterpreterMetadata.executionPhase = 'error';
              codeInterpreterMetadata.error = JSON.stringify(eventMessage.data);

              controller.error(
                new Error(
                  `Code Interpreter error: ${JSON.stringify(eventMessage.data)}`,
                ),
              );
            }

            // Handle done
            else if (eventMessage.event === 'done') {
              controller.close();
            }
          }
        } catch (error) {
          codeInterpreterMetadata.executionPhase = 'error';
          codeInterpreterMetadata.error =
            error instanceof Error ? error.message : String(error);
          controller.error(error);
        }
      },
    });
  }
}
