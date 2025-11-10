/**
 * Chat services for the unified pipeline architecture.
 *
 * Core services:
 * - StandardChatService: Standard chat execution (used by StandardChatHandler)
 * - AgentChatService: Agent-based tool execution (used by WebSearchTool)
 * - ToolRouterService: Determines when to use tools (used by ToolRouterEnricher)
 * - FileProcessingService: File processing utilities (used by FileProcessor)
 * - AIFoundryAgentHandler: AI Foundry agent execution (used by AgentChatHandler)
 *
 * All services use dependency injection and are designed for easy testing.
 */

export { StandardChatService } from './StandardChatService';
export { AgentChatService } from './AgentChatService';
export { ToolRouterService } from './ToolRouterService';
export { FileProcessingService } from './FileProcessingService';
export { AIFoundryAgentHandler } from './AIFoundryAgentHandler';

export type { StandardChatRequest } from './StandardChatService';
export type {
  WebSearchToolRequest,
  WebSearchToolResponse,
} from './AgentChatService';
