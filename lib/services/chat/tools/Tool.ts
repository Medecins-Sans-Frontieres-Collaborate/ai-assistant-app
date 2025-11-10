import { Session } from 'next-auth';

import { OpenAIModel } from '@/types/openai';

/**
 * Tool interface for all tools that can be executed by the chat system.
 */
export interface Tool {
  readonly type: string;
  readonly name: string;
  readonly description: string;

  /**
   * Executes the tool with the given parameters.
   */
  execute(params: any): Promise<ToolResult>;
}

/**
 * Result returned by tool execution.
 */
export interface ToolResult {
  text: string;
  citations?: Array<{
    number: number;
    title: string;
    url: string;
    date: string;
  }>;
  metadata?: Record<string, any>;
}

/**
 * Parameters for web search tool.
 */
export interface WebSearchToolParams {
  searchQuery: string;
  model: OpenAIModel;
  user: Session['user'];
}
