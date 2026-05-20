import { SearchMode } from '@/types/searchMode';

import { ChatContext, shouldExecuteAsAgent } from '../pipeline/ChatContext';
import { BasePipelineStage } from '../pipeline/PipelineStage';

/**
 * AgentEnricher adds AI Foundry agent capabilities.
 *
 * Responsibilities:
 * - Validates that the model has an agentId
 * - Sets execution strategy to 'agent'
 * - Prepares for AI Foundry agent execution
 *
 * Modifies context:
 * - context.executionStrategy = 'agent'
 *
 * Note: Agent mode currently supports text only.
 * If files/images are present, this enricher will skip.
 * Future: Could support agents with file/image understanding.
 */
export class AgentEnricher extends BasePipelineStage {
  readonly name = 'AgentEnricher';

  shouldRun(context: ChatContext): boolean {
    return !!context.agentMode && !!context.model.agentId;
  }

  protected async executeStage(context: ChatContext): Promise<ChatContext> {
    console.log(
      `[AgentEnricher] Using AI Foundry agent: ${context.model.agentId}`,
    );

    // Validate that model has agentId
    if (!context.model.agentId) {
      throw new Error(
        `Model ${context.modelId} does not have an agentId configured`,
      );
    }

    // Predicate is shared with ToolRouterEnricher so the two stages stay
    // in sync. Returns false when the agent would not be able to run
    // (today: when files/images are present), in which case we fall back
    // to standard execution with intelligent search.
    if (!shouldExecuteAsAgent(context)) {
      console.warn(
        '[AgentEnricher] Agent mode with files/images not yet supported, falling back to intelligent search with standard execution',
      );
      return {
        ...context,
        searchMode: SearchMode.INTELLIGENT,
        // Don't set executionStrategy='agent' — StandardChatHandler runs.
      };
    }

    return {
      ...context,
      executionStrategy: 'agent',
    };
  }
}
