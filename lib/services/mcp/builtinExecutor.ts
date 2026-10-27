/** Provider-neutral contract for request-bound in-process tools. */
export interface BuiltinToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface BuiltinToolResult {
  resultText: string;
  isError: boolean;
}
export interface BuiltinExecutor {
  listTools(): Promise<BuiltinToolDefinition[]>;
  callTool(
    name: string,
    args: unknown,
    context?: { emitActivity?: (detail: string) => void },
  ): Promise<BuiltinToolResult>;
  readonly instructions: string;
  /** Read-only tools allowed to execute inside a request instead of pausing. */
  readonly immediate?: boolean;
  remainingRounds?(): number;
  completeRound?(): void;
  /** Declarations needed only for providers validating historical tool blocks. */
  transcriptTools?(): BuiltinToolDefinition[];
  /** Provider-independent, explicitly requested preloads. Not model invocations. */
  preload?(): Promise<
    { toolName: string; argumentsJson: string; result: BuiltinToolResult }[]
  >;
  /** Snapshot carried only inside a server-signed continuation token. */
  continuationState?(): Record<string, unknown>;
  /** Mutable citations/quote corpus emitted at the terminal metadata block. */
  metadata?(): {
    citations: import('@/types/rag').Citation[];
    citationQuoteSources: Record<string, string>;
  };
}
