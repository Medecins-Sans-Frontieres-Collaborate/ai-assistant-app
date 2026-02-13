import { getAzureMonitorLogger } from '@/lib/services/observability';

import { AIFoundryAgentHandler } from '../AIFoundryAgentHandler';
import { ChatContext } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

/**
 * AgentChatHandler executes AI Foundry agent-based chat.
 *
 * Responsibilities:
 * - Executes when executionStrategy is 'agent'
 * - Uses AIFoundryAgentHandler for AI Foundry agent execution
 * - Handles agent-based chat with Bing grounding
 * - Returns the Response object
 *
 * Modifies context:
 * - context.response (the final HTTP Response)
 *
 * This runs as an alternative to StandardChatHandler.
 */
export class AgentChatHandler extends BasePipelineStage {
  readonly name = 'AgentChatHandler';

  constructor(private aiFoundryAgentHandler: AIFoundryAgentHandler) {
    super();
  }

  shouldRun(context: ChatContext): boolean {
    // Only run when agent execution is specified
    return context.executionStrategy === 'agent';
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    const startTime = Date.now();
    const logger = getAzureMonitorLogger();

    console.log('[AgentChatHandler] Executing AI Foundry agent chat');
    console.log('[AgentChatHandler] Model:', context.modelId);
    console.log('[AgentChatHandler] Agent ID:', context.model.agentId);
    console.log('[AgentChatHandler] Thread ID:', context.threadId);

    // Use enriched messages if available, otherwise use original messages
    const messagesToSend = context.enrichedMessages || context.messages;

    console.log('[AgentChatHandler] Message count:', messagesToSend.length);
    console.log('[AgentChatHandler] Capabilities:', {
      codeInterpreter:
        context.agentCapabilities?.codeInterpreter?.enabled || false,
      bingGrounding: context.agentCapabilities?.bingGrounding?.enabled || false,
      fileCount:
        context.agentCapabilities?.codeInterpreter?.uploadedFiles?.length || 0,
    });

    try {
      // Execute agent chat with capabilities
      const response = await this.aiFoundryAgentHandler.handleAgentChat(
        context.modelId,
        context.model,
        messagesToSend,
        context.temperature || 0.7,
        context.user,
        context.botId,
        context.threadId,
        context.agentCapabilities,
      );

      const duration = Date.now() - startTime;
      console.log('[AgentChatHandler] Agent chat execution completed');

      // Log successful agent execution (fire-and-forget)
      void logger.logAgentExecution({
        user: context.user,
        agentId: context.model.agentId || 'unknown',
        agentType: 'ai_foundry',
        threadId: context.threadId,
        duration,
        model: context.modelId,
        botId: context.botId,
      });

      return {
        ...context,
        response,
      };
    } catch (error) {
      // Log agent error (fire-and-forget)
      void logger.logAgentError({
        user: context.user,
        agentId: context.model.agentId,
        agentType: 'ai_foundry',
        threadId: context.threadId,
        errorCode: 'AGENT_EXECUTION_FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        model: context.modelId,
        botId: context.botId,
      });

      throw error;
    }
  }
}
