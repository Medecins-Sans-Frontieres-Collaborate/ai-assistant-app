import { Session } from 'next-auth';

import { getMessagesToSend } from '@/lib/utils/server/chat/chat';
import { getGlobalTiktoken } from '@/lib/utils/server/tiktoken/tiktokenCache';

import { AgentCapabilities } from '@/types/agent';
import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';
import { OpenAIModel } from '@/types/openai';

import { MetricsService } from '../observability/MetricsService';
import {
  AgentCapabilityHandler,
  BingGroundingHandler,
  CodeInterpreterHandler,
} from './agentCapabilities';

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

          // Select capability handler and create the response stream
          const capabilityHandler = this.selectCapabilityHandler(capabilities);
          const stream = capabilityHandler.createStream(streamEventMessages, {
            thread,
            isNewThread,
            startTime,
            uploadedFiles: capabilities?.codeInterpreter?.uploadedFiles,
          });

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
   * Selects the appropriate capability handler based on enabled capabilities.
   *
   * @param capabilities - Agent capabilities enabled for this execution
   * @returns The handler that should process the stream
   */
  private selectCapabilityHandler(
    capabilities?: AgentCapabilities,
  ): AgentCapabilityHandler {
    // Registered handlers in priority order
    const handlers: AgentCapabilityHandler[] = [
      new CodeInterpreterHandler(),
      new BingGroundingHandler(), // Default fallback
    ];

    // Return first handler that can handle the capabilities
    for (const handler of handlers) {
      if (handler.canHandle(capabilities)) {
        return handler;
      }
    }

    // Should never reach here since BingGroundingHandler handles all non-CodeInterpreter
    return new BingGroundingHandler();
  }
}
