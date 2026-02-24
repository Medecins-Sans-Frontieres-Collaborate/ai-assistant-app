/**
 * CodeInterpreterRouterService
 *
 * Determines whether Code Interpreter is needed for a given query using GPT-5-mini.
 * Analyzes user intent to intelligently route between Code Interpreter and standard chat.
 *
 * Code Interpreter IS needed for:
 * - Generating files (Excel, CSV, charts, images, documents)
 * - Data analysis requiring computation (statistics, aggregations, trends)
 * - Data transformation (format conversion, extraction, restructuring)
 * - Running Python code on data
 * - Creating visualizations or plots
 *
 * Code Interpreter is NOT needed for:
 * - Summarizing document contents (just reading)
 * - Explaining or describing code (no execution)
 * - Rewriting code in another language (text transformation)
 * - General questions about file contents
 * - Answering questions using file as context
 */
import { Message } from '@/types/chat';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OpenAI } from 'openai';

/**
 * Request structure for Code Interpreter routing decisions.
 */
export interface CodeInterpreterRouterRequest {
  /** Conversation messages for context */
  messages: Message[];

  /** Current user message text */
  currentMessage: string;

  /** File information for context */
  files?: {
    filename: string;
    type?: string;
  }[];

  /** Force Code Interpreter regardless of query analysis */
  forceCodeInterpreter?: boolean;
}

/**
 * Response from Code Interpreter routing decision.
 */
export interface CodeInterpreterRouterResponse {
  /** Whether Code Interpreter is recommended */
  needsCodeInterpreter: boolean;

  /** Explanation of the routing decision */
  reasoning: string;
}

/**
 * CodeInterpreterRouterService
 *
 * Analyzes user queries to determine if Code Interpreter execution is needed.
 * Uses GPT-5-mini for fast, efficient intent classification.
 */
export class CodeInterpreterRouterService {
  private tracer = trace.getTracer('code-interpreter-router-service');

  constructor(private openAIClient: OpenAI) {}

  /**
   * Determines whether Code Interpreter is needed for the current message.
   *
   * @param request - CodeInterpreterRouterRequest with messages and context
   * @returns CodeInterpreterRouterResponse with decision and reasoning
   */
  async determineIntent(
    request: CodeInterpreterRouterRequest,
  ): Promise<CodeInterpreterRouterResponse> {
    return await this.tracer.startActiveSpan(
      'code_interpreter_router.determine',
      {
        attributes: {
          'code_interpreter_router.force':
            request.forceCodeInterpreter || false,
          'code_interpreter_router.message_length':
            request.currentMessage.length,
          'code_interpreter_router.file_count': request.files?.length || 0,
        },
      },
      async (span) => {
        try {
          const { currentMessage, forceCodeInterpreter, files } = request;

          // If forceCodeInterpreter is true, skip AI analysis
          if (forceCodeInterpreter) {
            console.log(
              '[CodeInterpreterRouterService] Force Code Interpreter enabled, skipping AI decision',
            );
            span.setAttribute('code_interpreter_router.decision', 'forced');
            span.setStatus({ code: SpanStatusCode.OK });
            return {
              needsCodeInterpreter: true,
              reasoning: 'Forced Code Interpreter mode',
            };
          }

          // Build file context string for the prompt
          const fileContext =
            files && files.length > 0
              ? `Files present: ${files.map((f) => f.filename).join(', ')}`
              : 'No files uploaded';

          try {
            const systemPrompt = `You are a routing assistant that determines if a query requires Code Interpreter (Python code execution) capabilities.

Code Interpreter IS needed for:
- Generating files (Excel, CSV, charts, images, documents from scratch)
- Data analysis requiring computation (statistics, aggregations, trends, calculations)
- Data transformation (format conversion like PDF to Excel, data extraction to structured format)
- Running Python code or scripts on uploaded data
- Creating visualizations, plots, or charts
- Processing, cleaning, or restructuring data
- Mathematical or scientific computations
- File format conversions (e.g., PDF tables to Excel, JSON to CSV)

Code Interpreter is NOT needed for:
- Summarizing document contents (reading and explaining)
- Explaining or describing code without executing it
- Rewriting code in another programming language (text transformation)
- Answering general questions about file contents
- Text extraction or simple reading of documents
- Translation of content
- Creative writing or text generation
- General knowledge questions
- Code review or explanation

${fileContext}

Analyze the user's message and determine if it requires Code Interpreter capabilities.
Respond with JSON: { "needsCodeInterpreter": boolean, "reasoning": string }`;

            // Include recent conversation history for context
            const recentMessages = this.getRecentMessages(request.messages, 4);

            // Build messages array
            const conversationMessages = [
              { role: 'system' as const, content: systemPrompt },
              ...recentMessages.map((msg) => ({
                role: msg.role as 'user' | 'assistant' | 'system',
                content:
                  typeof msg.content === 'string'
                    ? msg.content
                    : this.extractTextContent(msg.content),
              })),
            ];

            console.log('[CodeInterpreterRouterService] Analyzing query:', {
              messagePreview: currentMessage.substring(0, 100),
              fileCount: files?.length || 0,
            });

            // Use gpt-5-mini for efficient routing decisions
            const response = await this.openAIClient.chat.completions.create({
              model: 'gpt-5-mini',
              messages: conversationMessages,
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'code_interpreter_router_response',
                  strict: true,
                  schema: {
                    type: 'object',
                    properties: {
                      needsCodeInterpreter: {
                        type: 'boolean',
                        description:
                          'Whether Code Interpreter (Python execution) is needed for this query',
                      },
                      reasoning: {
                        type: 'string',
                        description:
                          'Brief explanation of the routing decision',
                      },
                    },
                    required: ['needsCodeInterpreter', 'reasoning'],
                    additionalProperties: false,
                  },
                },
              },
            });

            const result = JSON.parse(
              response.choices[0].message.content || '{}',
            );

            console.log('[CodeInterpreterRouterService] AI decision:', result);

            span.setAttribute(
              'code_interpreter_router.needs_ci',
              result.needsCodeInterpreter,
            );
            span.setAttribute(
              'code_interpreter_router.reasoning',
              result.reasoning,
            );
            span.setStatus({ code: SpanStatusCode.OK });

            return {
              needsCodeInterpreter: result.needsCodeInterpreter,
              reasoning: result.reasoning || 'AI routing decision',
            };
          } catch (error) {
            console.error(
              '[CodeInterpreterRouterService] Error determining intent:',
              error,
            );
            span.recordException(error as Error);

            // Fail gracefully - default to not needing Code Interpreter
            // This preserves original behavior of standard chat
            return {
              needsCodeInterpreter: false,
              reasoning:
                'Error during intent analysis, defaulting to standard chat',
            };
          }
        } catch (error) {
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
   * Gets the most recent messages from the conversation for context.
   *
   * @param messages - Full message array
   * @param maxMessages - Maximum messages to return
   * @returns Recent messages slice
   */
  private getRecentMessages(
    messages: Message[],
    maxMessages: number,
  ): Message[] {
    if (messages.length <= maxMessages) {
      return messages;
    }
    return messages.slice(-maxMessages);
  }

  /**
   * Extracts text content from complex message content structures.
   *
   * @param content - Message content (string, array, or object)
   * @returns Extracted text string
   */
  private extractTextContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter((c): c is { type: string; text: string } => c.type === 'text')
        .map((c) => c.text);
      return textParts.join('\n');
    }

    if (
      content &&
      typeof content === 'object' &&
      'text' in content &&
      typeof (content as { text: unknown }).text === 'string'
    ) {
      return (content as { text: string }).text;
    }

    return '[non-text content]';
  }
}
