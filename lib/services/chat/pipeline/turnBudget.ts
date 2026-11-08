/**
 * Time budget for one chat turn, scaled to the work the turn may do.
 *
 * Every timer used to be a constant: 240 s for the tool stage (router +
 * web search + sandboxed code), 235 s for a sub-tool interpreter run, a
 * 250 s guard for everything before the model. Those fit one or two files.
 * On 2026-11-07 a five-document review spent ~160 s in the sandbox (14
 * code runs) — two thirds of the budget — so a larger set, or the same set
 * plus a web search, would have timed out and lost all the work.
 *
 * The budget is computed ONCE per request from what the turn can do (how
 * many files the sandbox would mount, whether code and search may run),
 * then threaded through the pipeline. A plain question gets exactly the
 * compiled defaults: nothing here ever SHORTENS a timer, it only lengthens
 * the ones a heavier turn needs, up to a ceiling. A longer budget costs
 * nothing unless the work actually runs that long; the route's heartbeat
 * keeps the stream alive meanwhile.
 *
 * Convention: all values are milliseconds; "documents" means files the
 * interpreter would mount this turn (selectInterpreterInputRefs).
 */

/** What a turn may do, as far as is known before it starts. */
export interface TurnWorkload {
  /** Files the sandbox would mount (attachments, else remounted ones). */
  documents: number;
  /** The interpreter may run as a pre-turn sub-tool (non-native model). */
  subToolInterpreter: boolean;
  /** The model runs the interpreter natively inside its own response. */
  nativeInterpreter: boolean;
  /** Web search may run this turn (auto or forced). */
  webSearch: boolean;
  /** The user's model timeout (time to first byte), already clamped. */
  modelTimeoutMs: number;
}

/** Timers for one turn. */
export interface TurnBudget {
  /** One sub-tool interpreter run (or document-trim pipeline). */
  interpreterMs: number;
  /** ToolRouterEnricher stage: decision + search + interpreter, in sequence. */
  toolStageMs: number;
  /** FileProcessor stage: download + extraction of every attachment. */
  fileStageMs: number;
  /** Guard for everything before the model handler starts. */
  preModelMs: number;
  /** Model time-to-first-byte (never below the user's own setting). */
  modelMs: number;
}

/** The compiled defaults a plain turn keeps (see ChatPipeline STAGE_TIMEOUTS). */
export const BASE_TURN_BUDGET = {
  interpreterMs: 235_000,
  toolStageMs: 240_000,
  fileStageMs: 180_000,
  preModelMs: 250_000,
} as const;

/** No single timer is ever raised above this (10 min, the model-timeout ceiling). */
export const TURN_TIMER_CEILING_MS = 600_000;

/**
 * Sandbox time per mounted document, on top of a fixed setup cost. From
 * the 2026-11-07 runs: five documents, 14 code runs, ~160 s; budgeting
 * 120 s + 30 s/document gives that turn 270 s (~70% headroom on the
 * measured time) and a ten-document turn 420 s.
 */
export const INTERPRETER_SETUP_MS = 120_000;
export const INTERPRETER_PER_DOCUMENT_MS = 30_000;

/**
 * Upper bound of a web search: the multi-step loop's admin time budget can
 * reach 180 s (MULTI_STEP_BOUNDS.timeBudgetSeconds.max) plus the 15 s
 * overrun margin. A single-step search ends sooner on its own timeout.
 * Budgeting the maximum costs nothing: the search stops on its own clock.
 */
export const WEB_SEARCH_MAX_MS = 195_000;

/** Router decision: auxiliary call plus the chat-model fallback (30 s). */
export const ROUTER_DECISION_MS = 45_000;

/** Extraction allowance per attachment beyond the first five. */
export const FILE_STAGE_PER_EXTRA_DOCUMENT_MS = 20_000;
const FILE_STAGE_INCLUDED_DOCUMENTS = 5;

/** Slack between an inner timer and the guard around it. */
const STAGE_SLACK_MS = 5_000;

/**
 * Pre-model work outside the tool stage (extraction, RAG, skills), per
 * document — measured at ~1 s per document on 2026-11-07, budgeted at 5 s.
 * The fixed share is the compiled guard's own slack over the tool stage
 * (250 s − 240 s), so a plain turn keeps exactly the compiled guard.
 */
const PRE_MODEL_SLACK_MS =
  BASE_TURN_BUDGET.preModelMs - BASE_TURN_BUDGET.toolStageMs;
const PRE_MODEL_PER_DOCUMENT_MS = 5_000;

/**
 * Time to first byte rises with context: every mounted document's excerpt
 * and every search result is input the model reads before answering.
 */
const MODEL_FLOOR_BASE_MS = 90_000;
const MODEL_FLOOR_PER_DOCUMENT_MS = 10_000;
const MODEL_FLOOR_SEARCH_MS = 30_000;

const clampTimer = (ms: number, floor: number) =>
  Math.min(TURN_TIMER_CEILING_MS, Math.max(floor, Math.round(ms)));

/**
 * Plans a turn's timers from its workload.
 *
 * @param workload - What the turn may do.
 * @returns Timers, each at least its compiled default and at most
 *          TURN_TIMER_CEILING_MS (except `preModelMs`, which sums the
 *          stages it guards).
 *
 * @example
 * planTurnBudget({ documents: 5, subToolInterpreter: true, nativeInterpreter: false,
 *                  webSearch: false, modelTimeoutMs: 90_000 }).interpreterMs; // 270_000
 */
export function planTurnBudget(workload: TurnWorkload): TurnBudget {
  const documents = Math.max(0, Math.floor(workload.documents));

  const interpreterMs = clampTimer(
    INTERPRETER_SETUP_MS + INTERPRETER_PER_DOCUMENT_MS * documents,
    BASE_TURN_BUDGET.interpreterMs,
  );

  // The tool stage runs its parts in sequence: the decision, then search,
  // then code. Its own ceiling is the sum, not one timer's ceiling.
  const toolStageMs = Math.max(
    BASE_TURN_BUDGET.toolStageMs,
    ROUTER_DECISION_MS +
      (workload.webSearch ? WEB_SEARCH_MAX_MS : 0) +
      (workload.subToolInterpreter ? interpreterMs + STAGE_SLACK_MS : 0),
  );

  const fileStageMs = clampTimer(
    BASE_TURN_BUDGET.fileStageMs +
      FILE_STAGE_PER_EXTRA_DOCUMENT_MS *
        Math.max(0, documents - FILE_STAGE_INCLUDED_DOCUMENTS),
    BASE_TURN_BUDGET.fileStageMs,
  );

  // Same rule as the compiled guard (longest stage + slack), plus the
  // per-document extraction and any extension of the file stage, which
  // runs before the tool stage.
  const preModelMs = Math.max(
    BASE_TURN_BUDGET.preModelMs,
    toolStageMs +
      PRE_MODEL_SLACK_MS +
      PRE_MODEL_PER_DOCUMENT_MS * documents +
      (fileStageMs - BASE_TURN_BUDGET.fileStageMs),
  );

  const heavy =
    documents > 0 || workload.webSearch || workload.nativeInterpreter;
  const modelFloor = heavy
    ? MODEL_FLOOR_BASE_MS +
      MODEL_FLOOR_PER_DOCUMENT_MS * documents +
      (workload.webSearch ? MODEL_FLOOR_SEARCH_MS : 0)
    : 0;
  const modelMs = clampTimer(
    Math.max(workload.modelTimeoutMs, modelFloor),
    workload.modelTimeoutMs,
  );

  return { interpreterMs, toolStageMs, fileStageMs, preModelMs, modelMs };
}
