/**
 * Token usage for conversation-workflow runs (docs/WORKFLOW_EMISSIONS_DESIGN.md).
 *
 * Leaf module — no server imports — because the same shapes travel the whole
 * way: the orchestrators collect them, the workflow stream/JSON routes send
 * them, and the client stores them on the conversation to render the impact
 * badge. Like chat's `TokenUsage`, only RAW counts are carried; CO2e is
 * computed at display time so editing config/emissions.json re-prices history.
 */

/** One model call inside a run (a run is usually several). */
export interface WorkflowCallUsage {
  /**
   * The phase that spent it: 'analysis' | 'translate' | 'review:2' |
   * 'extract' | 'transform' | 'assess' | 'photo' | 'profile' | 'rail_chat'.
   * Free-form so an orchestrator can name its own phases; the UI groups on it.
   */
  label: string;
  /** The model that actually served (post `resolveWorkflowModelId`). */
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The `usage` payload a workflow route sends back for one run. */
export interface WorkflowUsagePayload {
  /** The user-visible action that triggered the run ('translate', 'assess'…). */
  action: string;
  calls: WorkflowCallUsage[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Resolved region of the serving client; null = default (home) clients. */
  region: 'US' | 'EU' | null;
}

/**
 * One recorded run on the conversation's ledger (`Conversation.workflowUsage`).
 *
 * `artifactId` is stamped at WRITE time even when the UI shows only the
 * workspace total: any grouping stays re-derivable later, whereas a ledger
 * written without it can never be regrouped — the same trap chat is in, where
 * per-message served models were never recorded.
 */
export interface WorkflowRunUsage {
  id: string;
  /** ISO — powers "today" on the same local-midnight rule as the chat chip. */
  at: string;
  action: string;
  /** Stable key of the artifact this run was spent on (see artifactKey.ts). */
  artifactId: string;
  /** Label snapshot, so a past run still reads right after a rename. */
  artifactLabel?: string;
  modelId: string;
  region: 'US' | 'EU' | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  promptTokens: number;
  completionTokens: number;
  /** How many model calls the run made — "Agentic translation, 4 calls". */
  calls: number;
  /** Per-phase split, for the readout's "By action" rows. */
  byLabel?: Array<{
    label: string;
    promptTokens: number;
    completionTokens: number;
  }>;
}

/**
 * Ledger cap. A run record is ~200 bytes, so 200 runs is ~40 KB — comfortably
 * inside the conversation's localStorage budget while covering far more
 * history than any readout shows.
 */
export const WORKFLOW_USAGE_LEDGER_LIMIT = 200;

/** Sums a run list into the totals every readout row needs. */
export function sumWorkflowRuns(runs: readonly WorkflowRunUsage[]): {
  promptTokens: number;
  completionTokens: number;
  runs: number;
  calls: number;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let calls = 0;
  for (const run of runs) {
    promptTokens += run.promptTokens;
    completionTokens += run.completionTokens;
    calls += run.calls;
  }
  return { promptTokens, completionTokens, runs: runs.length, calls };
}
