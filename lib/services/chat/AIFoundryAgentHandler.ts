import { Session } from 'next-auth';

import {
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { getMessagesToSend } from '@/lib/utils/server/chat/chat';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktoken/tiktokenCache';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { MetricsService } from '../observability/MetricsService';

import { env } from '@/config/environment';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * Handles Azure AI Foundry Agent-based chat completions
 *
 * Uses @azure/ai-projects (AIProjectClient) with the Foundry Agent Service API:
 * - project.getOpenAIClient() → openAIClient for conversations and responses
 * - openAIClient.conversations.create({items}) - creates a new conversation
 * - openAIClient.conversations.items.create(conversationId, {items}) - adds items
 * - openAIClient.responses.create({conversation, agent_reference}) - gets response stream
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
          const aiProjects = await import('@azure/ai-projects');
          const { DefaultAzureCredential } = await import('@azure/identity');

          // AI Foundry uses a separate project endpoint (services.ai.azure.com)
          const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
          const agentId = modelConfig.agentId;

          if (!endpoint || !agentId) {
            throw new Error(
              'Azure AI Foundry endpoint or Agent ID not configured',
            );
          }

          const project = new aiProjects.AIProjectClient(
            endpoint,
            new DefaultAzureCredential(),
          );
          const openAIClient = await project.getOpenAIClient();

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

          // Build the last user message content
          const lastMessage = processedMessages[processedMessages.length - 1];
          let messageContent: string;

          if (typeof lastMessage.content === 'string') {
            messageContent = lastMessage.content;
          } else if (Array.isArray(lastMessage.content)) {
            // For multimodal content, concatenate text parts
            // The new API handles images differently - extract text for now
            messageContent = lastMessage.content
              .map(
                (
                  item:
                    | TextMessageContent
                    | ImageMessageContent
                    | FileMessageContent,
                ) => {
                  if (item.type === 'text') {
                    return item.text;
                  } else if (item.type === 'image_url') {
                    return '[Image attached]';
                  } else if (item.type === 'file_url') {
                    return `[File attached: ${item.originalFilename || 'file'}]`;
                  }
                  return '';
                },
              )
              .filter(Boolean)
              .join('\n');
          } else if (
            typeof lastMessage.content === 'object' &&
            'text' in lastMessage.content
          ) {
            messageContent = (lastMessage.content as TextMessageContent).text;
          } else {
            messageContent = String(lastMessage.content);
          }

          let conversationId: string;
          let isNewConversation = false;

          try {
            if (threadId) {
              // Reuse existing conversation
              conversationId = threadId;
            } else {
              // Create a new conversation with the first message
              const conversation = await openAIClient.conversations.create({
                items: [
                  {
                    type: 'message',
                    role: 'user',
                    content: messageContent,
                  },
                ],
              });
              conversationId = conversation.id;
              isNewConversation = true;
            }
          } catch (convError) {
            console.error('Error with conversation:', convError);
            throw convError;
          }

          // If reusing an existing conversation, add the new message
          if (!isNewConversation) {
            try {
              await openAIClient.conversations.items.create(conversationId, {
                items: [
                  {
                    type: 'message',
                    role: 'user',
                    content: messageContent,
                  },
                ],
              });
            } catch (messageError) {
              console.error(
                'Error adding message to conversation:',
                messageError,
              );
              throw messageError;
            }
          }

          // Create a response (replaces runs.create)
          let streamEventMessages;
          try {
            console.log('Creating response with:', {
              conversationId,
              agentName: String(agentId),
              endpoint: endpoint,
            });

            const stream = await openAIClient.responses.create(
              {
                conversation: conversationId,
                stream: true,
              },
              {
                body: {
                  agent: {
                    name: String(agentId),
                    type: 'agent_reference',
                  },
                },
              },
            );

            streamEventMessages = stream;
          } catch (streamError: any) {
            console.error('Error creating stream:', streamError);
            if (streamError instanceof Error) {
              console.error('Error stack:', streamError.stack);
            }
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
              // Separate counters for marker-based and annotation-based citations
              // to avoid numbering conflicts between the two systems
              let markerCitationIndex = 1;
              const citationMap = new Map<string, number>();

              // markerBuffer: Accumulates text to handle citation markers split across chunks
              let markerBuffer = '';
              let controllerClosed = false;

              try {
                for await (const event of streamEventMessages) {
                  // Handle Responses API stream events
                  // Events use 'type' field, not 'event'
                  if (event.type === 'response.output_text.delta') {
                    const textChunk = event.delta;

                    // Stage 1: Accumulate text in marker buffer
                    markerBuffer += textChunk;

                    // Stage 2: Process complete citation markers in accumulated buffer
                    //
                    // Azure agents may return inline citation markers:
                    // - Short: 【3:0†source】 (just the word "source")
                    // - Long:  【3:0†Title†URL】 (embedded title and URL)
                    const processedBuffer = markerBuffer.replace(
                      /【(\d+):(\d+)†[^】]+】/g,
                      (match: string) => {
                        if (!citationMap.has(match)) {
                          citationMap.set(match, markerCitationIndex);
                          markerCitationIndex++;
                        }
                        return `[${citationMap.get(match)}]`;
                      },
                    );

                    // Stage 3: Check for incomplete markers at end of buffer
                    const lastOpenBracket = processedBuffer.lastIndexOf('【');
                    const lastCloseBracket = processedBuffer.lastIndexOf('】');

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
                  } else if (
                    event.type === 'response.output_text.annotation.added'
                  ) {
                    // Collect citation annotations as they arrive
                    // These provide structured citation data (URL, title)
                    // numbered independently from inline markers
                    const annotation = event as any;
                    if (
                      annotation.annotation?.type === 'url_citation' &&
                      annotation.annotation?.url
                    ) {
                      citations.push({
                        number: citations.length + 1,
                        title:
                          annotation.annotation.title ||
                          `Source ${citations.length + 1}`,
                        url: annotation.annotation.url,
                        date: '',
                      });
                    }
                  } else if (event.type === 'response.completed') {
                    // Flush any remaining marker buffer
                    if (markerBuffer) {
                      controller.enqueue(encoder.encode(markerBuffer));
                      markerBuffer = '';
                    }

                    // Append metadata at the very end using utility function
                    // Keep metadata field name as threadId to avoid client-side breakage
                    appendMetadataToStream(controller, {
                      citations: citations.length > 0 ? citations : undefined,
                      threadId: isNewConversation ? conversationId : undefined,
                    });

                    controllerClosed = true;
                    controller.close();
                  } else if (event.type === 'response.failed') {
                    const errorEvent = event as any;
                    controllerClosed = true;
                    controller.error(
                      new Error(
                        `Agent error: ${errorEvent.response?.error?.message || 'Unknown error'}`,
                      ),
                    );
                  }
                }

                // If stream ended without response.completed, close gracefully
                if (!controllerClosed) {
                  if (markerBuffer) {
                    controller.enqueue(encoder.encode(markerBuffer));
                  }
                  appendMetadataToStream(controller, {
                    citations: citations.length > 0 ? citations : undefined,
                    threadId: isNewConversation ? conversationId : undefined,
                  });
                  controller.close();
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

          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute('response.stream', true);
          span.setAttribute('agent.duration_ms', duration);

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
