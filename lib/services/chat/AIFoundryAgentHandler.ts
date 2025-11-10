import { Session } from 'next-auth';

import {
  appendMetadataToStream,
  createStreamEncoder,
  deduplicateCitations,
} from '@/lib/utils/app/metadata';
import { getMessagesToSend } from '@/lib/utils/server/chat';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktokenCache';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { MetricsService } from '../observability/MetricsService';

import { env } from '@/config/environment';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Handles Azure AI Foundry Agent-based chat completions with Bing grounding
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
   * Handles chat completion using Azure AI Foundry Agents
   */
  async handleAgentChat(
    modelId: string,
    modelConfig: OpenAIModel,
    messages: Message[],
    temperature: number,
    user: Session['user'],
    botId: string | undefined,
    threadId?: string,
  ): Promise<Response> {
    const startTime = Date.now();

    // Create OpenTelemetry span for tracing
    return await this.tracer.startActiveSpan(
      'ai_foundry_agent.chat',
      {
        attributes: {
          'agent.id': modelConfig.agentId || 'unknown',
          'agent.model': modelId,
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
        },
      },
      async (span) => {
        try {
          // Use Azure AI Agents SDK for streaming support
          const aiAgents = await import('@azure/ai-agents');
          const { DefaultAzureCredential } = await import('@azure/identity');

          // AI Foundry uses a separate project endpoint (services.ai.azure.com)
          const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
          const agentId = modelConfig.agentId;

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
            // The SDK expects parameters to be passed separately: (threadId, role, content)
            // For multimodal content (images, files), convert to SDK format
            let messageContent:
              | string
              | Array<
                  | { type: 'text'; text: string }
                  | {
                      type: 'image_url';
                      imageUrl: { url: string; detail: string };
                    }
                >;

            if (typeof lastMessage.content === 'string') {
              // Simple text message
              messageContent = lastMessage.content;
            } else if (Array.isArray(lastMessage.content)) {
              // Multimodal content - convert to Azure SDK format
              messageContent = lastMessage.content.map(
                (
                  item:
                    | TextMessageContent
                    | ImageMessageContent
                    | FileMessageContent,
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
                  return item;
                },
              );
            } else if (
              typeof lastMessage.content === 'object' &&
              'text' in lastMessage.content
            ) {
              // Single TextMessageContent object
              messageContent = (lastMessage.content as TextMessageContent).text;
            } else {
              // Fallback
              messageContent = String(lastMessage.content);
            }

            await client.messages.create(thread.id, 'user', messageContent);
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

          // Create a readable stream for the response
          const stream = new ReadableStream({
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
              let hasCompletedMessage = false;

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
                        (contentPart: {
                          type: string;
                          text?: { value: string };
                        }) => {
                          if (
                            contentPart.type === 'text' &&
                            contentPart.text?.value
                          ) {
                            let textChunk = contentPart.text.value;

                            // Convert citation format on the fly
                            textChunk = textChunk.replace(
                              /【(\d+):(\d+)†source】/g,
                              (match: string) => {
                                if (!citationMap.has(match)) {
                                  citationMap.set(match, citationIndex);
                                  console.log(
                                    `[AIFoundryAgentHandler] New citation marker: ${match} -> [${citationIndex}]`,
                                  );
                                  citationIndex++;
                                }
                                return `[${citationMap.get(match)}]`;
                              },
                            );

                            controller.enqueue(encoder.encode(textChunk));
                          }
                        },
                      );
                    }
                  } else if (
                    eventMessage.event === 'thread.message.completed'
                  ) {
                    hasCompletedMessage = true;

                    console.log(
                      '[AIFoundryAgentHandler] Final citationMap (inline markers to numbers):',
                      Array.from(citationMap.entries()),
                    );

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
                      const annotations =
                        messageData.content[0].text.annotations;

                      console.log(
                        '[AIFoundryAgentHandler] Raw annotations from agent:',
                        JSON.stringify(annotations, null, 2),
                      );

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
                          console.log(
                            `[AIFoundryAgentHandler] Warning: No annotation found for marker ${marker}, using placeholder`,
                          );
                        }
                      }

                      console.log(
                        '[AIFoundryAgentHandler] Processed citations (matched to citationMap):',
                        JSON.stringify(citations, null, 2),
                      );
                    }
                  } else if (eventMessage.event === 'thread.run.completed') {
                    // Append metadata at the very end using utility function
                    // No need to deduplicate - citationMap already ensured uniqueness
                    appendMetadataToStream(controller, {
                      citations: citations.length > 0 ? citations : undefined,
                      threadId: isNewThread ? thread.id : undefined,
                    });
                  } else if (eventMessage.event === 'error') {
                    controller.error(
                      new Error(
                        `Agent error: ${JSON.stringify(eventMessage.data)}`,
                      ),
                    );
                  } else if (eventMessage.event === 'done') {
                    controller.close();
                  }
                }
              } catch (error) {
                controller.error(error);
              }
            },
          });

          // Record metrics
          const duration = Date.now() - startTime;
          MetricsService.recordRequest('agent', duration, {
            user,
            success: true,
            model: modelId,
            botId,
          });

          // TODO: Extract token usage from agent response and record
          // MetricsService.recordTokenUsage({ total: tokens }, { user, model: modelId, operation: 'agent', botId });

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('response.stream', true);
          span.setAttribute('agent.duration_ms', duration);

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          });
        } catch (error) {
          // Record exception in span
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });

          // Record error metrics
          MetricsService.recordError('agent_execution_failed', {
            user,
            operation: 'agent',
            model: modelId,
            message: error instanceof Error ? error.message : 'Unknown error',
          });

          MetricsService.recordRequest('agent', Date.now() - startTime, {
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
}
