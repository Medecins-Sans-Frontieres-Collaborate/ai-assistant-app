/**
 * Shared map size limits. The workspace cap previously lived as three private
 * MAX_FEATURES copies (MapWorkspace, mapRailChat, map/chat route) — new code
 * imports from here so the workspace and admin-dataset caps cannot drift.
 */

/** Hard cap on features in one map workspace (rendering + prompt budgets). */
export const MAP_MAX_FEATURES = 2_000;

/**
 * Admin dataset caps. Equal to the workspace cap by design: a larger dataset
 * could not be loaded in v1 (loads are all-or-nothing snapshots). Raising
 * this later requires partial/filtered loading and workspace-side perf work.
 */
export const MAX_DATASET_FEATURES = MAP_MAX_FEATURES;
export const MAX_DATASET_CONNECTIONS = 2_000;
export const MAX_DATASET_NAME_CHARS = 120;
export const MAX_DATASET_DESCRIPTION_CHARS = 300;
