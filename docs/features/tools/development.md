# Tools Development Guide

This guide provides instructions on how to extend, modify, or remove tools within the AI Assistant application.

## Table of Contents

1. [How to Extend Tools (Adding a New Tool)](#how-to-extend-tools-adding-a-new-tool)
2. [How to Edit an Existing Tool](#how-to-edit-an-existing-tool)
3. [How to Remove a Tool](#how-to-remove-a-tool)
4. [Testing Tools](#testing-tools)
5. [Best Practices](#best-practices)

---

## How to Extend Tools (Adding a New Tool)

Adding a new tool involves three main steps: implementing the tool, updating the router, and integrating the execution.

### 1. Implement the Tool Interface

Create a new file in `lib/services/chat/tools/` (e.g., `CalculatorTool.ts`):

```typescript
import { Tool, ToolResult } from './Tool';

export class CalculatorTool implements Tool {
  readonly type = 'calculator';
  readonly name = 'Calculator';
  readonly description = 'Performs mathematical calculations';

  async execute(params: { expression: string }): Promise<ToolResult> {
    // Implementation logic here
    const result = eval(params.expression); // Use a safer alternative in production
    return {
      text: `The result of ${params.expression} is ${result}`,
    };
  }
}
```

### 2. Update ToolRouterService

Modify `lib/services/chat/ToolRouterService.ts` to inform the AI about the new tool:

1.  Update the `systemPrompt` to include descriptions of when to use the new tool.
2.  Update the `json_schema` in the `determineTool` method to include the new tool type and any necessary parameters.

### 3. Integrate with ToolRouterEnricher

Update `lib/services/chat/enrichers/ToolRouterEnricher.ts`:

1.  Initialize your new tool in the constructor.
2.  Update `executeStage` to handle the execution of your new tool when it is returned by the `ToolRouterService`.

---

## How to Edit an Existing Tool

### Modifying Logic

To change how a tool works (e.g., `WebSearchTool`), modify its `execute()` method in `lib/services/chat/tools/WebSearchTool.ts`.

### Modifying Routing Logic

If the assistant is choosing a tool too often or not often enough, adjust the `systemPrompt` in `ToolRouterService.ts`. This prompt is the primary way to "program" the intelligent routing.

---

## How to Remove a Tool

To completely remove a tool:

1.  Remove the tool implementation from `lib/services/chat/tools/`.
2.  Remove any references and initialization in `ToolRouterEnricher.ts`.
3.  Remove the tool's description and routing logic from `ToolRouterService.ts`.
4.  Remove the tool from the `ToolType` type definition in `types/chat.ts`.

---

## Testing Tools

### Unit Tests

Create unit tests for your tools in `__tests__/lib/services/chat/tools/`.
Example: `WebSearchTool.test.ts`

### Integration Tests

Test the full routing and enrichment flow in `__tests__/lib/services/chat/enrichers/ToolRouterEnricher.test.ts`.

### Manual Testing

1.  Set `SearchMode` to `ALWAYS` to force the tool to run.
2.  Check the server logs for `[ToolRouterEnricher]` and `[ToolRouterService]` entries.
3.  Verify the `context.enrichedMessages` contains the expected tool output.

---

## Best Practices

1.  **Privacy First**: Only send necessary data to external tools/agents. Avoid sending the full conversation history unless absolutely required.
2.  **Graceful Failure**: Always wrap tool execution in try-catch blocks. If a tool fails, the chat should still proceed (possibly with a note to the user).
3.  **Lightweight Routing**: Route helper calls through `AuxiliaryCompletionService` (`lib/services/auxiliary/auxiliaryCompletion.ts`) with a new `AuxiliaryOperation` and a probe builder in `lib/services/auxiliary/probes.ts`; it runs on the small residency-verified models for the user's region.
4.  **Citations**: When fetching external information, always provide citations in the `ToolResult` to maintain transparency.
5.  **Structured Output**: Use JSON schemas for tool routing to ensure the results are easily machine-readable.
