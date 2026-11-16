# Tools Integration & Dependencies

This document covers how the Tools feature is integrated into the application and its external dependencies.

## Table of Contents

1. [Pipeline Integration](#pipeline-integration)
2. [External Dependencies](#external-dependencies)
3. [Configuration](#configuration)
4. [Tracing and Observability](#tracing-and-observability)

---

## Pipeline Integration

The Tools feature is integrated as a stage in the unified `ChatPipeline`.

### Initialization

In `app/api/chat/route.ts`, the `ToolRouterEnricher` is initialized and added to the pipeline:

```typescript
const pipeline = new ChatPipeline([
  // ... other stages
  new RAGEnricher(env.SEARCH_ENDPOINT!, env.SEARCH_INDEX!),
  new ToolRouterEnricher(toolRouterService, agentChatService),
  new AgentEnricher(),
  // ...
]);
```

### Context Interaction

The `ToolRouterEnricher` interacts with the `ChatContext` in several ways:

- **Reads**: `context.searchMode` to determine if it should run.
- **Reads**: `context.messages` and `context.processedContent` (summaries/transcripts) to provide context to the tool router.
- **Writes**: `context.enrichedMessages` by inserting tool results as system messages.
- **Writes**: `context.processedContent.metadata.citations` to store search citations.

---

## External Dependencies

### 1. AI Foundry (Azure AI)

- **Purpose**: Used for the actual web search execution.
- **Service**: `AIFoundryAgentHandler` is used by `AgentChatService` to call specialized agents.
- **Privacy**: Only the search query is sent to the agent. The full user conversation history remains within the application.

### 2. OpenAI / Compatible API

- **Purpose**: Used by `ToolRouterService` for intelligent tool routing decisions.
- **Model**: the residency-routed auxiliary chain (small per-region utility models assigned under Models in Admin), with the user's chat model as the fallback. All helper-model calls go through `AuxiliaryCompletionService` (`lib/services/auxiliary/auxiliaryCompletion.ts`); never hardcode a model on the default client.
- **JSON Schema**: Uses strict JSON schema mode to ensure reliable tool selection responses.

---

## Configuration

The Tools feature relies on several configuration settings:

### Environment Variables

- `OPENAI_API_KEY`: Used for the `ToolRouterService`.
- `AZURE_AI_AGENT_ENDPOINT`: (Implicitly used by `AIFoundryAgentHandler`)
- `AZURE_AI_AGENT_KEY`: (Implicitly used by `AIFoundryAgentHandler`)

### Search Modes

The feature's behavior is governed by the `SearchMode` enum:

- `INTELLIGENT`: Dynamic AI-based routing.
- `ALWAYS`: Forced tool execution.
- `NONE`: Tools disabled.

---

## Tracing and Observability

The feature uses OpenTelemetry for detailed tracing:

### ToolRouterService Traces

- `tool_router.determine`: Main span for tool selection.
- Attributes: `tool_router.force_web_search`, `tool_router.decision`, `tool_router.needs_web_search`.

### AgentChatService Traces

- `agent.web_search`: Main span for web search execution.
- `agent.parse_response`: Span for parsing the streaming response and citations.
- Attributes: `search.query`, `search.model`, `search.citations_count`.

These traces allow for monitoring the performance and accuracy of tool routing and execution in production.
