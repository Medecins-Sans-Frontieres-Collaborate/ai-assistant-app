/**
 * Admin-controlled enable/disable policy for conversation workflows.
 *
 * ONE document (`system/workflows/policy.json`) in the centralized admin
 * container, edited only by global admins. It is an ADDITIONAL gate layered
 * on top of every other condition a workflow already has:
 *
 *   LaunchDarkly `conversationWorkflows` (rollout, client-side)
 *     → this policy (admin kill switch, server + client)
 *       → per-workflow criteria (e.g. the grants Entra attribute rule)
 *
 * A workflow the policy disables is unavailable even when every other
 * criterion is met — that is the whole point: an admin can keep something
 * dark (or switch it off in an incident) without a redeploy or an LD change.
 *
 * DEFAULTS ARE PER-WORKFLOW, and deliberately not uniform. The four general
 * workflows default to ENABLED, because they already ship behind the LD flag
 * and an unauthored policy must not switch them off underneath users. Grants
 * defaults to DISABLED: it is a restricted, team-specific pipeline that must
 * not become reachable merely because the code was deployed — an admin has
 * to turn it on explicitly. The same default applies while the policy blob
 * is unreadable, so a storage outage fails closed for grants and open for
 * the rest.
 */
import {
  Principal,
  matchesPrincipal,
} from '@/lib/services/shared/principalMatching';

import {
  CONVERSATION_WORKFLOW_TYPES,
  ConversationWorkflowType,
} from '@/types/workflow';

import { z } from 'zod';

export const WORKFLOW_POLICY_PREFIX = 'system/workflows/';
export const WORKFLOW_POLICY_PATH = `${WORKFLOW_POLICY_PREFIX}policy.json`;
export const WORKFLOW_POLICY_HISTORY_PREFIX = `${WORKFLOW_POLICY_PREFIX}history/`;

export const WORKFLOW_POLICY_DEFAULTS: Record<
  ConversationWorkflowType,
  boolean
> = {
  translation: true,
  document: true,
  'data-analysis': true,
  map: true,
  grants: false,
  // Ships under the same LD flag as the other general workflows; the policy
  // stays the kill switch (docs/DOCUMENT_FILL_ASSESSMENT.md §11).
  'form-fill': true,
  // Drafting only; publishing has its own default-off gate (design §11.1).
  'channel-drafter': true,
};

/**
 * Optional parts of a workflow that an admin can switch on or off on their
 * own, without touching the workflow itself. A feature is only ever
 * available while its workflow is enabled, so switching a workflow off
 * switches off everything under it.
 *
 * To add one: add its id here with the workflow it belongs to and its
 * default, add `workflowsAdmin.features.<id>` strings, and gate the routes
 * with `isWorkflowFeatureEnabled` (guard.ts). The admin panel lists it under
 * its workflow automatically.
 */
export const WORKFLOW_FEATURE_IDS = [
  'translation-preserve-formatting',
] as const;

export type WorkflowFeatureId = (typeof WORKFLOW_FEATURE_IDS)[number];

/**
 * One number an admin can set for a feature. `default` applies until the
 * policy says otherwise; `min` and `max` are compiled bounds that no saved
 * value or override can leave, so a typo in the admin page cannot remove a
 * limit altogether.
 */
export interface WorkflowFeatureLimitDefinition {
  default: number;
  min: number;
  max: number;
}

export interface WorkflowFeatureDefinition {
  /** The workflow the feature belongs to and depends on. */
  workflow: ConversationWorkflowType;
  /** State when no policy is saved, or the saved one does not mention it. */
  defaultEnabled: boolean;
  /** Numbers an admin can set, by key, in the order the admin page shows. */
  limits?: Record<string, WorkflowFeatureLimitDefinition>;
}

export const WORKFLOW_FEATURES: Record<
  WorkflowFeatureId,
  WorkflowFeatureDefinition
> = {
  // Document mode's "Preserve formatting" layout: the native PDF pipeline
  // behind /api/document-translation/native.
  'translation-preserve-formatting': {
    workflow: 'translation',
    defaultEnabled: true,
    // Read through nativePdfLimits() (nativePdf.ts), which also keeps the
    // three in order: default batch ≤ largest batch ≤ document total.
    limits: {
      // Pages a batch takes unless the person raises it.
      defaultBatchPages: { default: 6, min: 1, max: 50 },
      // The most a person may raise one batch to. A batch is sent as
      // requests of NATIVE_PDF_MAX_PAGES, one after the other, which share
      // the document brief; 50 pages is nine of them.
      maxBatchPages: { default: 50, min: 1, max: 50 },
      // Pages of one document that may be translated in total.
      maxDocumentPages: { default: 50, min: 1, max: 100 },
    },
  },
};

/** Who an override applies to; the scopes usage limits use, minus groups. */
export const WORKFLOW_FEATURE_OVERRIDE_SCOPES = [
  'user',
  'domain',
  'attribute',
] as const;
export type WorkflowFeatureOverrideScope =
  (typeof WORKFLOW_FEATURE_OVERRIDE_SCOPES)[number];

/**
 * Precedence, lowest first: a later scope's value replaces an earlier one's,
 * so the most specific match (the person) wins.
 */
const OVERRIDE_PRECEDENCE: readonly WorkflowFeatureOverrideScope[] = [
  'domain',
  'attribute',
  'user',
];

export const MAX_FEATURE_OVERRIDES = 50;
export const MAX_OVERRIDE_TARGETS = 50;

/** The features that belong to one workflow, in declaration order. */
export function workflowFeaturesOf(
  type: ConversationWorkflowType,
): WorkflowFeatureId[] {
  return WORKFLOW_FEATURE_IDS.filter(
    (id) => WORKFLOW_FEATURES[id].workflow === type,
  );
}

export const WorkflowSettingSchema = z.object({
  enabled: z.boolean(),
});
export type WorkflowSetting = z.infer<typeof WorkflowSettingSchema>;

const FeatureLimitValuesSchema = z.record(z.string(), z.number());

/**
 * Different limits for some people: a user (mail), a mail domain, or a
 * directory attribute such as `department:health`. A limit the override
 * leaves out is inherited from the feature's own setting.
 */
export const WorkflowFeatureOverrideSchema = z.object({
  scope: z.enum(WORKFLOW_FEATURE_OVERRIDE_SCOPES),
  targets: z.array(z.string().trim().min(1)).min(1).max(MAX_OVERRIDE_TARGETS),
  limits: FeatureLimitValuesSchema,
});
export type WorkflowFeatureOverride = z.infer<
  typeof WorkflowFeatureOverrideSchema
>;

export const WorkflowFeatureSettingSchema = z.object({
  enabled: z.boolean(),
  /** Values for the feature's limits; a missing key keeps its default. */
  limits: FeatureLimitValuesSchema.optional(),
  overrides: z
    .array(WorkflowFeatureOverrideSchema)
    .max(MAX_FEATURE_OVERRIDES)
    .optional(),
});
export type WorkflowFeatureSetting = z.infer<
  typeof WorkflowFeatureSettingSchema
>;

/**
 * Read schema — permissive on keys so a policy written by a newer build
 * (with a workflow this build does not know) still parses; unknown keys are
 * simply never consulted.
 */
export const WorkflowPolicySchema = z.object({
  version: z.literal(1),
  workflows: z.record(z.string(), WorkflowSettingSchema).default({}),
  /** Per-feature switches (WORKFLOW_FEATURES); absent in older documents. */
  features: z.record(z.string(), WorkflowFeatureSettingSchema).optional(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type WorkflowPolicy = z.infer<typeof WorkflowPolicySchema>;

export const WorkflowPolicyHistoryEntrySchema = z.object({
  version: z.literal(1),
  policy: WorkflowPolicySchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type WorkflowPolicyHistoryEntry = z.infer<
  typeof WorkflowPolicyHistoryEntrySchema
>;

/** Effective enabled state for one workflow under a (possibly absent) policy. */
export function resolveWorkflowEnabled(
  policy: WorkflowPolicy | null | undefined,
  type: ConversationWorkflowType,
): boolean {
  const setting = policy?.workflows[type];
  if (setting) return setting.enabled;
  return WORKFLOW_POLICY_DEFAULTS[type];
}

/** Effective state for every known workflow — what `/me` returns. */
export function resolveAllWorkflowsEnabled(
  policy: WorkflowPolicy | null | undefined,
): Record<ConversationWorkflowType, boolean> {
  const out = {} as Record<ConversationWorkflowType, boolean>;
  for (const type of CONVERSATION_WORKFLOW_TYPES) {
    out[type] = resolveWorkflowEnabled(policy, type);
  }
  return out;
}

/**
 * The admin's own switch for one feature, ignoring its workflow: the saved
 * setting, or the feature's default. This is what the admin panel edits.
 */
export function resolveWorkflowFeatureSetting(
  policy: WorkflowPolicy | null | undefined,
  id: WorkflowFeatureId,
): boolean {
  const setting = policy?.features?.[id];
  if (setting) return setting.enabled;
  return WORKFLOW_FEATURES[id].defaultEnabled;
}

/**
 * Whether a feature is actually available: its own switch is on AND its
 * workflow is enabled. This is what enforcement and the workspace use.
 */
export function resolveWorkflowFeatureEnabled(
  policy: WorkflowPolicy | null | undefined,
  id: WorkflowFeatureId,
): boolean {
  return (
    resolveWorkflowEnabled(policy, WORKFLOW_FEATURES[id].workflow) &&
    resolveWorkflowFeatureSetting(policy, id)
  );
}

/** Effective availability of every known feature — what `/me` returns. */
export function resolveAllWorkflowFeaturesEnabled(
  policy: WorkflowPolicy | null | undefined,
): Record<WorkflowFeatureId, boolean> {
  const out = {} as Record<WorkflowFeatureId, boolean>;
  for (const id of WORKFLOW_FEATURE_IDS) {
    out[id] = resolveWorkflowFeatureEnabled(policy, id);
  }
  return out;
}

/** A value held inside its limit's compiled bounds, as a whole number. */
function clampLimit(
  value: number,
  definition: WorkflowFeatureLimitDefinition,
): number {
  if (!Number.isFinite(value)) return definition.default;
  return Math.min(Math.max(Math.round(value), definition.min), definition.max);
}

/**
 * A feature's limits for one person: the compiled defaults, then the saved
 * values, then every override that matches the person, least specific
 * first (domain, attribute, user). Every result lies inside the limit's
 * compiled bounds, whatever was saved.
 *
 * @param policy - The saved policy, if any.
 * @param id - The feature.
 * @param principal - Who is asking; without one no override applies.
 * @returns One value per limit the feature declares (empty when none).
 */
export function resolveWorkflowFeatureLimits(
  policy: WorkflowPolicy | null | undefined,
  id: WorkflowFeatureId,
  principal?: Principal | null,
): Record<string, number> {
  const definitions = WORKFLOW_FEATURES[id].limits ?? {};
  const setting = policy?.features?.[id];
  const layers: Record<string, number>[] = [setting?.limits ?? {}];
  if (principal) {
    for (const scope of OVERRIDE_PRECEDENCE) {
      for (const override of setting?.overrides ?? []) {
        if (
          override.scope === scope &&
          matchesPrincipal(principal, scope, override.targets)
        ) {
          layers.push(override.limits);
        }
      }
    }
  }
  const resolved: Record<string, number> = {};
  for (const [key, definition] of Object.entries(definitions)) {
    let value = definition.default;
    for (const layer of layers) {
      if (typeof layer[key] === 'number') value = layer[key];
    }
    resolved[key] = clampLimit(value, definition);
  }
  return resolved;
}

/**
 * Why a feature setting an admin is saving cannot be accepted, or null.
 * Stricter than the read schema on purpose: reads tolerate what an older
 * or newer build wrote, writes refuse what this build cannot honour.
 *
 * @param id - The feature the setting is for.
 * @param setting - The setting as parsed from the request.
 */
export function featureSettingProblem(
  id: WorkflowFeatureId,
  setting: WorkflowFeatureSetting,
): string | null {
  const definitions = WORKFLOW_FEATURES[id].limits ?? {};
  const check = (limits: Record<string, number>, where: string) => {
    for (const [key, value] of Object.entries(limits)) {
      const definition = definitions[key];
      if (!definition) return `${where}: unknown limit "${key}"`;
      if (
        !Number.isInteger(value) ||
        value < definition.min ||
        value > definition.max
      ) {
        return `${where}: ${key} must be a whole number from ${definition.min} to ${definition.max}`;
      }
    }
    return null;
  };
  const own = check(setting.limits ?? {}, id);
  if (own) return own;
  for (const [index, override] of (setting.overrides ?? []).entries()) {
    const problem = check(override.limits, `${id} override ${index + 1}`);
    if (problem) return problem;
  }
  return null;
}

export function historyBlobPath(timestamp: string, updatedBy: string): string {
  const safeTs = timestamp.replace(/[^0-9TZ]/g, '');
  const safeBy = updatedBy.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
  return `${WORKFLOW_POLICY_HISTORY_PREFIX}${safeTs}-${safeBy}.json`;
}
