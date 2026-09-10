/**
 * Run-shape constants shared by the workflow orchestrators and the client's
 * pre-flight estimate (docs/WORKFLOW_EMISSIONS_DESIGN.md §5d).
 *
 * Leaf module — no imports at all — because the client imports it to predict
 * what a run will cost, and must not drag server plumbing (`@azure/identity`,
 * the OpenAI SDK) into the browser bundle to learn a number.
 */

/** Upper bound on agentic review rounds; the loop stops early on approval. */
export const MAX_REVIEW_ROUNDS = 3;

/**
 * Model calls an agentic translation makes at MOST: the analysis pass, the
 * translation itself, and up to MAX_REVIEW_ROUNDS reviews. A run that is
 * approved on the first round makes three.
 */
export const AGENTIC_TRANSLATION_MAX_PASSES = 2 + MAX_REVIEW_ROUNDS;
