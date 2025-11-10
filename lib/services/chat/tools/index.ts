/**
 * Tools for the chat system.
 *
 * Tools are capabilities that can be executed during chat to enhance responses:
 * - WebSearchTool: Search the web for current information
 *
 * Tools are managed by ToolRegistry and executed by ToolRouterEnricher.
 */

export type { Tool, ToolResult, WebSearchToolParams } from './Tool';
export { WebSearchTool } from './WebSearchTool';
export { ToolRegistry } from './ToolRegistry';
