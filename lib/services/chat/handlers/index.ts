/**
 * Execution Handlers
 *
 * Execute the final chat request after content processing and feature enrichment.
 *
 * Handlers run as the last stage in the pipeline:
 * - AgentChatHandler: Executes AI Foundry agent chat (for agent mode)
 * - StandardChatHandler: Executes standard OpenAI chat completion (default)
 *
 * Handlers are responsible for:
 * - Building final messages from processed content and enrichments
 * - Calling the appropriate service (standard, agent, RAG)
 * - Returning the HTTP Response
 */

export { AgentChatHandler } from './AgentChatHandler';
export { StandardChatHandler } from './StandardChatHandler';
