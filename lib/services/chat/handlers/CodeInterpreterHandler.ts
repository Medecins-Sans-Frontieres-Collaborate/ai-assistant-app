/**
 * CodeInterpreterHandler
 *
 * Handles Code Interpreter execution in the chat pipeline.
 *
 * Responsibilities:
 * - Executes AI Foundry agent with Code Interpreter tool
 * - Handles Code Interpreter-specific streaming events
 * - Extracts generated file annotations
 * - Streams code execution output and results
 */
import { AIFoundryAgentHandler } from '../AIFoundryAgentHandler';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

import { SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * CodeInterpreterHandler executes Code Interpreter agent requests.
 *
 * Runs when:
 * - context.executionStrategy === 'code_interpreter'
 *
 * Uses AIFoundryAgentHandler with Code Interpreter extension.
 */
export class CodeInterpreterHandler extends BasePipelineStage {
  readonly name = 'CodeInterpreterHandler';
  private tracer = trace.getTracer('code-interpreter-handler');

  constructor(private aiFoundryAgentHandler: AIFoundryAgentHandler) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    return context.executionStrategy === 'code_interpreter';
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    return await this.tracer.startActiveSpan(
      'code_interpreter.execute',
      {
        attributes: {
          'user.id': context.user.id,
          'model.id': context.modelId,
          'files.count': context.codeInterpreterFiles?.length || 0,
        },
      },
      async (span) => {
        try {
          console.log('[CodeInterpreterHandler] Executing Code Interpreter', {
            modelId: context.modelId,
            agentId: context.model.agentId,
            files: context.codeInterpreterFiles?.map((f) => f.filename),
            threadId: context.threadId,
          });

          // Get agent ID - prefer codeInterpreterAgentId if set, otherwise use agentId
          const agentId =
            context.model.codeInterpreterAgentId || context.model.agentId;

          if (!agentId) {
            throw new Error(
              `Model ${context.modelId} does not have a Code Interpreter agent configured`,
            );
          }

          // Get messages to send - use enrichedMessages if available
          const messages = context.enrichedMessages || context.messages;

          // Execute using AIFoundryAgentHandler with Code Interpreter mode
          const response =
            await this.aiFoundryAgentHandler.handleCodeInterpreterChat(
              context.modelId,
              context.model,
              messages,
              context.temperature || 0.5,
              context.user,
              context.botId,
              context.threadId,
              context.codeInterpreterFiles || [],
            );

          span.setStatus({ code: SpanStatusCode.OK });

          return {
            ...context,
            response,
          };
        } catch (error) {
          console.error('[CodeInterpreterHandler] Error:', error);
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
}
