# Tools Architecture & Workflows

This document describes the internal architecture of the Tools feature and the workflows involved in tool selection and execution.

## Table of Contents

1. [High-Level Workflow](#high-level-workflow)
2. [Code Structure](#code-structure)
3. [Component Responsibilities](#component-responsibilities)
4. [Data Flow Diagram](#data-flow-diagram)
5. [Key Files](#key-files)

---

## High-Level Workflow

The execution of tools is integrated into the `ChatPipeline` via the `ToolRouterEnricher` stage.

1.  **Trigger**: When a user sends a message, the `ChatPipeline` is initialized.
2.  **Enrichment Selection**: The `ToolRouterEnricher.shouldRun()` method checks if the current `searchMode` is `INTELLIGENT` or `ALWAYS`.
3.  **Tool Routing Decision**:
    - The enricher calls `ToolRouterService.determineTool()`.
    - In `ALWAYS` mode, it immediately selects `web_search`.
    - In `INTELLIGENT` mode, it uses a lightweight LLM (the residency-routed auxiliary chain, see `lib/services/auxiliary/auxiliaryCompletion.ts`) to analyze the user's message and conversation context to decide if web search is needed.
4.  **Tool Execution**:
    - If a tool is selected (e.g., `web_search`), the enricher calls the corresponding tool's `execute()` method.
    - For `WebSearchTool`, it delegates the search to `AgentChatService.executeWebSearchTool()`.
5.  **Context Enrichment**:
    - The results (text and citations) are formatted into a system message.
    - This system message is inserted into the conversation context _before_ the user's last message.
    - Citations are stored in the context metadata for the UI to display.

---

## Code Structure

### Core Interface

Located in `lib/services/chat/tools/Tool.ts`:

```typescript
export interface Tool {
  readonly type: string;
  readonly name: string;
  readonly description: string;
  execute(params: any): Promise<ToolResult>;
}
```

### Tool Registry

Located in `lib/services/chat/tools/ToolRegistry.ts`:
Manages a map of tool types to tool instances, allowing for dynamic lookup.

---

## Component Responsibilities

### ToolRouterEnricher

- **Stage**: Pipeline Stage (Enricher)
- **Role**: Orchestrator
- **Logic**: Extracts text from the user's message (including file summaries/transcripts), calls the router service, executes the selected tools, and modifies the `ChatContext` with the results.

### ToolRouterService

- **Role**: Decision Maker
- **Logic**: Uses LLM-based reasoning to determine if a query requires external tools. It generates optimized search queries when needed.

### WebSearchTool

- **Role**: Specialized Tool Implementation
- **Logic**: Encapsulates the web search capability. It uses privacy-preserving techniques by only sending the search query to the agent, not the full history.

### AgentChatService

- **Role**: Agent Orchestrator
- **Logic**: Communicates with AI Foundry agents. It handles the streaming response and parses it to extract both the generated text and citation metadata.

---

## Data Flow Diagram

```
┌─────────────┐       ┌───────────────────┐       ┌────────────────────┐
│ User Message│──────▶│ ChatPipeline      │──────▶│ ToolRouterEnricher │
└─────────────┘       └───────────────────┘       └─────────┬──────────┘
                                                            │
                                                            ▼
                                                  ┌────────────────────┐
                                                  │ ToolRouterService  │
                                                  │ (AI Decision)      │
                                                  └─────────┬──────────┘
                                                            │
                    ┌───────────────────────────────────────┴──────────────┐
                    │                                                      │
          [Tool Needed]                                             [No Tool Needed]
                    │                                                      │
                    ▼                                                      ▼
          ┌───────────────────┐                                   ┌────────────────┐
          │ WebSearchTool     │                                   │ Continue       │
          │ .execute()        │                                   │ Pipeline       │
          └─────────┬─────────┘                                   └────────────────┘
                    │
                    ▼
          ┌───────────────────┐
          │ AgentChatService  │──▶ [AI Foundry Web Search]
          └─────────┬─────────┘
                    │
                    ▼
          ┌───────────────────┐
          │ Format Results as │
          │ System Message    │
          └─────────┬─────────┘
                    │
                    ▼
          ┌───────────────────┐
          │ Update Context    │──▶ [Citations in Metadata]
          │ enrichedMessages  │
          └───────────────────┘
```

---

## Key Files

| File                     | Path                                                | Description                                           |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------- |
| **Tool Interface**       | `lib/services/chat/tools/Tool.ts`                   | Definition of the `Tool` and `ToolResult` interfaces. |
| **Tool Registry**        | `lib/services/chat/tools/ToolRegistry.ts`           | Central registry for tool management.                 |
| **Web Search Tool**      | `lib/services/chat/tools/WebSearchTool.ts`          | Implementation of the web search capability.          |
| **Tool Router Enricher** | `lib/services/chat/enrichers/ToolRouterEnricher.ts` | Pipeline stage for tool orchestration.                |
| **Tool Router Service**  | `lib/services/chat/ToolRouterService.ts`            | AI-powered decision logic for tool selection.         |
| **Agent Chat Service**   | `lib/services/chat/AgentChatService.ts`             | Executes searches via AI Foundry.                     |
| **Chat Pipeline**        | `lib/services/chat/pipeline/ChatPipeline.ts`        | Orchestrates the entire chat process including tools. |
