import { Session } from 'next-auth';

import {
  appendMetadataToStream,
  createStreamEncoder,
} from '@/lib/utils/app/metadata';
import { getMessagesToSend } from '@/lib/utils/server/chat/chat';
import { extractPendingApprovalIds } from '@/lib/utils/server/foundryErrors';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktoken/tiktokenCache';
import { isAllowedFoundryHost } from '@/lib/utils/shared/foundryHostAllowlist';

import {
  ApprovalResponse,
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { ErrorCode, PipelineError } from '@/types/errors';
import { OpenAIModel } from '@/types/openai';

import { MetricsService } from '../observability/MetricsService';
import {
  activityKeyForEvent,
  mcpCallItemToRecord,
  outputItemToMarker,
} from './foundryEventMappers';

import { env } from '@/config/environment';
import { STREAMING_RESPONSE_HEADERS } from '@/lib/constants/streaming';
import {
  emitAgentActivity,
  emitConsentOutcome,
  emitConsentRequest,
} from '@/lib/streamMarkers';
import { TokenCredential } from '@azure/identity';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/** MCP approval-response item shape — `@azure/ai-projects` doesn't export this yet. */
interface McpApprovalResponseItem {
  type: 'mcp_approval_response';
  approval_request_id: string;
  approve: boolean;
}

function buildApprovalResponseItems(
  decisions: ReadonlyArray<{ approval_request_id: string; approve: boolean }>,
): McpApprovalResponseItem[] {
  return decisions.map((r) => ({
    type: 'mcp_approval_response',
    approval_request_id: r.approval_request_id,
    approve: r.approve,
  }));
}

/**
 * Handles Azure AI Foundry Agent-based chat via @azure/ai-projects.
 * The Foundry Agent Service exposes its API through the OpenAI Responses
 * SDK (project.getOpenAIClient → conversations + responses).
 */
export class AIFoundryAgentHandler {
  private tracer = trace.getTracer('ai-foundry-agent-handler');

  constructor() {}

  async handleAgentChat(
    modelId: string,
    modelConfig: OpenAIModel,
    messages: Message[],
    temperature: number,
    user: Session['user'],
    botId: string | undefined,
    threadId?: string,
    credential?: TokenCredential,
    endpoint?: string,
    approvalResponses?: ApprovalResponse[],
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

          // Per-request endpoint/credential (OBO + GDPR routing); default to
          // service-level auth otherwise.
          const resolvedEndpoint = endpoint || env.AZURE_AI_FOUNDRY_ENDPOINT;
          const agentId = modelConfig.agentId;

          if (!resolvedEndpoint || !agentId) {
            throw new Error(
              'Azure AI Foundry endpoint or Agent ID not configured',
            );
          }

          // Defense-in-depth host check. The pipeline middleware already
          // validates this; we re-check here to guard non-pipeline callers.
          if (!isAllowedFoundryHost(resolvedEndpoint)) {
            throw new Error(
              `Refusing to invoke Foundry against disallowed host: ${resolvedEndpoint}`,
            );
          }

          const resolvedCredential = credential || new DefaultAzureCredential();

          const project = new aiProjects.AIProjectClient(
            resolvedEndpoint,
            resolvedCredential,
          );
          const openAIClient = await project.getOpenAIClient();

          // When approvalResponses are present we're resuming a paused
          // turn — post mcp_approval_response items instead of a new user
          // message, and Foundry continues the agent stream.
          const hasApprovals =
            !!approvalResponses && approvalResponses.length > 0;

          if (hasApprovals && !threadId) {
            throw new Error(
              'Cannot submit tool approval without an active conversation (threadId is required for approvalResponses)',
            );
          }

          let conversationId: string;
          let isNewConversation = false;

          if (hasApprovals) {
            conversationId = threadId as string;
            try {
              await openAIClient.conversations.items.create(conversationId, {
                items: buildApprovalResponseItems(approvalResponses!) as any,
              });
              console.log('[AIFoundryAgentHandler] Submitted approvals:', {
                conversationId,
                count: approvalResponses!.length,
              });
            } catch (approvalError) {
              console.error(
                'Error adding approval responses to conversation:',
                approvalError,
              );
              throw approvalError;
            }
          } else {
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

            const lastMessage = processedMessages[processedMessages.length - 1];
            let messageContent: string;

            if (typeof lastMessage.content === 'string') {
              messageContent = lastMessage.content;
            } else if (Array.isArray(lastMessage.content)) {
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

            try {
              if (threadId) {
                conversationId = threadId;
              } else {
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
          }

          if (isNewConversation) {
            // Foundry's runtime sometimes hasn't indexed a brand-new
            // conversation by the time responses.create fires, which
            // produces an empty turn. We pay just enough delay to win the
            // race in the common case; the empty-response detection at
            // `response.completed` is the safety net for slow indexing.
            await new Promise((r) => setTimeout(r, 200));
          }

          // Foundry's preview runtime requires `agent_reference` (the legacy
          // `agent` key is deprecated). The OpenAI SDK's options.body
          // REPLACES the params body, so conversation + stream are restated.
          const agentVersion = modelConfig.agentVersion;
          const createStream = () =>
            openAIClient.responses.create(
              {
                conversation: conversationId,
                stream: true,
              },
              {
                body: {
                  conversation: conversationId,
                  stream: true,
                  agent_reference: {
                    type: 'agent_reference',
                    name: String(agentId),
                    ...(agentVersion ? { version: agentVersion } : {}),
                  },
                },
              },
            );

          let streamEventMessages;
          let autoDeniedApprovalIds: string[] = [];
          try {
            console.log('Creating response with:', {
              conversationId,
              agentName: String(agentId),
              endpoint: resolvedEndpoint,
              usingOBO: !!credential,
            });

            try {
              streamEventMessages = await createStream();
            } catch (firstAttempt: any) {
              // Foundry rejects new turns while approvals are pending.
              // Treat a new user message as "move on" — auto-deny the
              // outstanding approvals and retry.
              const pendingIds = extractPendingApprovalIds(firstAttempt);
              if (pendingIds.length === 0) throw firstAttempt;

              console.log(
                '[AIFoundryAgentHandler] Auto-denying pending approvals before retry:',
                pendingIds,
              );
              await openAIClient.conversations.items.create(conversationId, {
                items: buildApprovalResponseItems(
                  pendingIds.map((id) => ({
                    approval_request_id: id,
                    approve: false,
                  })),
                ) as any,
              });
              autoDeniedApprovalIds = pendingIds;
              streamEventMessages = await createStream();
            }
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

              // Flip matching consent cards out of "pending" before the
              // new content streams in.
              if (autoDeniedApprovalIds.length > 0) {
                controller.enqueue(
                  encoder.encode(
                    emitAgentActivity('chat.activity.cancellingPriorTool'),
                  ),
                );
                for (const deniedId of autoDeniedApprovalIds) {
                  controller.enqueue(
                    encoder.encode(
                      emitConsentOutcome({
                        approval_request_id: deniedId,
                        approve: false,
                      }),
                    ),
                  );
                }
              }
              let citations: Array<{
                number: number;
                title: string;
                url: string;
                date: string;
              }> = [];
              // Marker-based vs annotation-based citations use separate
              // counters so their numbering doesn't collide.
              let markerCitationIndex = 1;
              const citationMap = new Map<string, number>();

              // Buffers text across chunks to handle citation markers
              // that arrive split.
              let markerBuffer = '';
              let controllerClosed = false;
              let sawMeaningfulOutput = false;
              // Dedupe output items — Foundry fires both `.added` and
              // `.done` for the same item.
              const emittedItemIds = new Set<string>();
              const emittedToolRecordIds = new Set<string>();
              // item.id → start time, used to compute duration_ms on `.done`.
              const mcpCallStartTimes = new Map<string, number>();

              try {
                for await (const event of streamEventMessages) {
                  if (event.type === 'response.output_text.delta') {
                    const textChunk = event.delta;
                    if (textChunk) sawMeaningfulOutput = true;

                    markerBuffer += textChunk;

                    // Rewrite Azure inline citation markers — both shapes:
                    //   short: 【3:0†source】
                    //   long:  【3:0†Title†URL】
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

                    // Hold back any incomplete marker tail.
                    const lastOpenBracket = processedBuffer.lastIndexOf('【');
                    const lastCloseBracket = processedBuffer.lastIndexOf('】');

                    if (lastOpenBracket > lastCloseBracket) {
                      const completeText = processedBuffer.slice(
                        0,
                        lastOpenBracket,
                      );
                      if (completeText) {
                        controller.enqueue(encoder.encode(completeText));
                      }
                      markerBuffer = processedBuffer.slice(lastOpenBracket);
                    } else {
                      controller.enqueue(encoder.encode(processedBuffer));
                      markerBuffer = '';
                    }
                  } else if (
                    event.type === 'response.output_text.annotation.added'
                  ) {
                    // Structured url_citation annotations, separate from
                    // the inline markers above.
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
                  } else if (
                    event.type === 'response.output_item.added' ||
                    event.type === 'response.output_item.done'
                  ) {
                    // Item shapes (oauth_consent_request / mcp_approval_request /
                    // mcp_call): see learn.microsoft.com/en-us/azure/foundry/agents.
                    const evt = event as any;
                    const item = evt.item;
                    if (item?.id && !emittedItemIds.has(item.id)) {
                      const marker = outputItemToMarker(item);
                      if (marker !== null) {
                        emittedItemIds.add(item.id);
                        sawMeaningfulOutput = true;
                        controller.enqueue(encoder.encode(marker));
                      }
                    }
                    if (
                      item?.id &&
                      item?.type === 'mcp_call' &&
                      event.type === 'response.output_item.added' &&
                      !mcpCallStartTimes.has(item.id)
                    ) {
                      mcpCallStartTimes.set(item.id, Date.now());
                    }
                    // `.done` carries final output/error/status — emit
                    // the persistent record for the tool usage summary.
                    if (
                      item?.id &&
                      item?.type === 'mcp_call' &&
                      event.type === 'response.output_item.done' &&
                      !emittedToolRecordIds.has(item.id)
                    ) {
                      const startedAt = mcpCallStartTimes.get(item.id);
                      const duration_ms =
                        typeof startedAt === 'number'
                          ? Date.now() - startedAt
                          : undefined;
                      const record = mcpCallItemToRecord(item, {
                        duration_ms,
                      });
                      if (record !== null) {
                        emittedToolRecordIds.add(item.id);
                        sawMeaningfulOutput = true;
                        controller.enqueue(encoder.encode(record));
                      }
                    }
                  } else if (
                    // Some Foundry SDK versions emit OAuth via a raw event
                    // instead of an output_item — handle both shapes.
                    (event as { type?: string }).type ===
                    'response.oauth_consent_requested'
                  ) {
                    const evt = event as unknown as {
                      id?: string;
                      consent_link?: string;
                      server_label?: string;
                    };
                    const id = evt.id || evt.consent_link;
                    if (id && !emittedItemIds.has(id) && evt.consent_link) {
                      emittedItemIds.add(id);
                      sawMeaningfulOutput = true;
                      controller.enqueue(
                        encoder.encode(
                          emitConsentRequest({
                            kind: 'oauth',
                            consent_url: evt.consent_link,
                            server_label: evt.server_label || null,
                          }),
                        ),
                      );
                    }
                  } else if (
                    activityKeyForEvent((event as { type?: string }).type)
                  ) {
                    // Built-in tool lifecycle events drive the loading text.
                    const activityKey = activityKeyForEvent(
                      (event as { type?: string }).type,
                    );
                    if (activityKey) {
                      controller.enqueue(
                        encoder.encode(emitAgentActivity(activityKey)),
                      );
                    }
                  } else if (event.type === 'response.completed') {
                    if (markerBuffer) {
                      controller.enqueue(encoder.encode(markerBuffer));
                      markerBuffer = '';
                    }

                    if (!sawMeaningfulOutput) {
                      console.error(
                        '[AIFoundryAgentHandler] response.completed with no output',
                        {
                          conversationId,
                          isNewConversation,
                          agentName: String(agentId),
                        },
                      );
                      controllerClosed = true;
                      controller.error(
                        new Error(
                          'Agent returned an empty response. Please try again.',
                        ),
                      );
                      return;
                    }

                    // `threadId` is the client-side name; don't rename.
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
        } catch (error: any) {
          // Handle 403 Forbidden — user doesn't have RBAC access to this agent
          const statusCode =
            error?.statusCode || error?.status || error?.response?.status;
          if (statusCode === 403) {
            span.setAttribute('error.type', 'authorization_denied');
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: 'User not authorized for this agent',
            });

            MetricsService.recordError('agent_authorization_denied', {
              user,
              operation: 'agent',
              model: modelId,
              message: 'User does not have access to this agent',
            });

            throw PipelineError.error(
              ErrorCode.AUTH_UNAUTHORIZED,
              "You don't have access to this agent. Contact your IT admin to request the Azure AI User role.",
              { agentId: modelConfig.agentId, model: modelId },
              error instanceof Error ? error : undefined,
            );
          }

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
