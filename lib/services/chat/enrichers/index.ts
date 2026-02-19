/**
 * Feature Enrichers
 *
 * Add feature capabilities (RAG, search, agents) to chat requests.
 *
 * Enrichers run in the pipeline's feature enrichment stage:
 * - RAGEnricher: Adds Azure AI Search knowledge base integration
 * - ToolRouterEnricher: Adds intelligent web search capabilities
 * - CodeInterpreterRouterEnricher: Intelligently routes to Code Interpreter
 * - AgentEnricher: Switches to AI Foundry agent execution
 *
 * All enrichers implement PipelineStage and modify ChatContext.enrichedMessages.
 * Enrichers are orthogonal to content types - they work with any content.
 */

export { RAGEnricher } from './RAGEnricher';
export { ToolRouterEnricher } from './ToolRouterEnricher';
export { CodeInterpreterRouterEnricher } from './CodeInterpreterRouterEnricher';
export { AgentEnricher } from './AgentEnricher';
