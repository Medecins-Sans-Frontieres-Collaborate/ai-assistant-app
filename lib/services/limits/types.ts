/**
 * Usage limits — Zod schemas and blob paths.
 *
 * See docs/LIMITS.md. Read-side schemas are deliberately PERMISSIVE per the
 * schema-evolution rule stated in lib/services/agentAccess/types.ts: new
 * fields must be optional/defaulted so previously-stored blobs keep parsing.
 * The STRICT write schemas live in the admin route, where rejecting an
 * unknown key is the correct behaviour.
 *
 * No node:crypto or other node builtins here, so client components may
 * value-import the schemas and the scope enum.
 */
import { z } from 'zod';

export const LIMITS_PREFIX = 'system/limits/';
export const LIMITS_POLICY_PATH = `${LIMITS_PREFIX}policy.json`;
export const LIMITS_HISTORY_PREFIX = `${LIMITS_PREFIX}history/`;
export const LIMITS_USAGE_PREFIX = `${LIMITS_PREFIX}usage/`;

/**
 * ⚠ `null` means UNLIMITED — an explicit statement. A key being ABSENT from
 * an override's `entries` means INHERIT from the layer below. These are two
 * different things and the admin UI must render them as distinct controls,
 * or an admin will "clear" a field expecting inheritance and instead grant
 * someone unlimited access.
 */
export const LimitValueSchema = z.union([
  z.number().int().nonnegative().max(1_000_000_000),
  z.null(),
  z.boolean(),
]);
export type LimitValue = z.infer<typeof LimitValueSchema>;

export const LimitEntrySchema = z.object({
  limitKey: z.string().min(1),
  /**
   * Model qualifier; at most one of the two. Absent → applies to every model.
   * NOTE: `series` is OPTIONAL on OpenAIModel (types/openai.ts:163), so a
   * model that declares none simply never produces a `family:` candidate.
   */
  modelId: z.string().optional(),
  series: z.string().optional(),
  value: LimitValueSchema,
  /**
   * GLOBAL defaults only: when true, no override may resolve ABOVE this
   * value. This is the lever that answers "may a per-user exception raise a
   * cap" — yes by default, no when a global admin ticks Hard ceiling.
   */
  ceiling: z.boolean().default(false),
});
export type LimitEntry = z.infer<typeof LimitEntrySchema>;

/**
 * ONE scope per override record, deliberately: a record that carried both
 * user and domain targets would behave as a user-layer override for one
 * principal and a domain-layer override for another, and its precedence
 * would depend on who was asking.
 */
export const OverrideScopeSchema = z.enum([
  /** Graph `mail`, lowercased. */
  'user',
  /** Bare domain, exact match on the part after the LAST '@'. */
  'domain',
  /** 'department:<v>' | 'company:<v>' | 'office:<v>'. */
  'attribute',
  /** Entra group object id — PERSISTED, NEVER EVALUATED in v1. */
  'group',
]);
export type OverrideScope = z.infer<typeof OverrideScopeSchema>;

export const LimitOverrideSchema = z.object({
  /** Server-generated `lim-<12 hex>`; immutable, and the final tie-break. */
  id: z.string().regex(/^lim-[0-9a-f]{12}$/),
  label: z.string().default(''),
  enabled: z.boolean().default(true),
  scope: OverrideScopeSchema,
  targets: z.array(z.string().max(320)).default([]),
  /** Admin tie-break WITHIN a layer. Higher wins. */
  priority: z.number().int().min(-1000).max(1000).default(0),
  /** SPARSE — only the keys this override speaks to. */
  entries: z.array(LimitEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type LimitOverride = z.infer<typeof LimitOverrideSchema>;

export const LimitsModeSchema = z.enum(['observe', 'enforce']);
export type LimitsMode = z.infer<typeof LimitsModeSchema>;

export const LimitsFailModeSchema = z.enum(['open', 'closed']);
export type LimitsFailMode = z.infer<typeof LimitsFailModeSchema>;

export const LimitsPolicySchema = z.object({
  version: z.literal(1),
  /** Global defaults. A key absent here falls back to the compiled catalog. */
  defaults: z.array(LimitEntrySchema).default([]),
  overrides: z.array(LimitOverrideSchema).default([]),
  /**
   * 'observe' resolves and logs every would-block decision but rejects
   * nothing. Ships as this so an admin can watch real org data for a week
   * before limits bite, and flip to 'enforce' with no redeploy.
   */
  mode: LimitsModeSchema.default('observe'),
  /**
   * Behaviour when the policy or a counter is unreadable. 'open' is the
   * deliberate INVERSION of AgentAccessService, which fails closed because
   * it is a security control — a quota is a cost control, and failing closed
   * turns a blob outage into a total chat outage for the whole org.
   */
  failMode: LimitsFailModeSchema.default('open'),
  /**
   * Single org-wide IANA zone for period boundaries. Resolved via
   * Intl.DateTimeFormat, so every replica agrees without a new dependency.
   */
  timezone: z.string().default('UTC'),
  /**
   * `byom-` models run against the USER'S OWN Foundry account under their own
   * OBO token and cost the org nothing, so they are exempt by default.
   */
  countByomUsage: z.boolean().default(false),
  /** Background LLM calls (title, summarize, memories, tone, revise). */
  countAuxiliaryUsage: z.boolean().default(false),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type LimitsPolicy = z.infer<typeof LimitsPolicySchema>;

/** Immutable audit copy written alongside every successful policy write. */
export const LimitsHistoryEntrySchema = z.object({
  version: z.literal(1),
  action: z.literal('upsert'),
  policy: LimitsPolicySchema.nullable().default(null),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type LimitsHistoryEntry = z.infer<typeof LimitsHistoryEntrySchema>;

export const PeriodKindSchema = z.enum(['day', 'month', 'total']);
export type PeriodKind = z.infer<typeof PeriodKindSchema>;

/**
 * ONE document per (subject, window) holding ALL of that window's counters,
 * so a chat request debiting several cells does so in a SINGLE
 * compare-and-swap — all-or-nothing, one GET + one PUT.
 */
export const UsageDocSchema = z.object({
  version: z.literal(1),
  /** Entra oid (session.user.id) — stable across a mail rename. */
  subjectId: z.string().min(1),
  periodKind: PeriodKindSchema,
  /** '2026-07-24' | '2026-07' | 'all' */
  period: z.string().min(1),
  counters: z.record(z.string(), z.number().nonnegative()).default({}),
  updatedAt: z.string(),
});
export type UsageDoc = z.infer<typeof UsageDocSchema>;

/** The empty policy an unconfigured deployment behaves as. */
export function emptyPolicy(updatedBy = 'system'): LimitsPolicy {
  return LimitsPolicySchema.parse({
    version: 1,
    defaults: [],
    overrides: [],
    updatedBy,
    updatedAt: new Date(0).toISOString(),
  });
}

export function historyBlobPath(timestamp: string, updatedBy: string): string {
  const safeTimestamp = timestamp.replace(/[^0-9A-Za-z.-]/g, '_');
  const safeUser = updatedBy.replace(/[^0-9A-Za-z.@-]/g, '_').slice(0, 64);
  return `${LIMITS_HISTORY_PREFIX}${safeTimestamp}-${safeUser}.json`;
}
