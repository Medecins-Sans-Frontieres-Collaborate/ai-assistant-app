/**
 * WRITE-side schemas for the limits policy, shared by the global admin's full
 * PUT (/api/limits/policy) and the scoped per-override path
 * (/api/limits/scoped/overrides/[id]).
 *
 * Deliberately STRICTER than the permissive read schema in
 * lib/services/limits/types.ts, which must keep parsing every already-stored
 * blob. Two write paths validating with ONE schema is the point: an entry the
 * global PUT clamps to its hardCeiling must be clamped identically when a
 * scoped admin writes it, or the two paths would disagree about what the
 * stored number means.
 *
 * Model/series qualifiers are validated by SHAPE ONLY, never against the live
 * model catalog: ids come from always-on Foundry discovery and vary per ring,
 * so a limit pinned to a model absent from THIS ring must still persist.
 *
 * Server-only by role (only the two routes import it); the client has its own
 * editor-side validation in components/Limits/types.ts.
 */
import { DELEGATION_ID_RE } from '@/lib/services/limits/types';

import { DIMENSION_RE, LIMIT_KEYS, getLimitDefinition } from '@/config/limits';
import { z } from 'zod';

/** Bounds the single-document design: ~1MB worst case, KBs realistically. */
export const MAX_OVERRIDES = 200;
export const MAX_ENTRIES_PER_OVERRIDE = 50;
export const MAX_TARGETS_PER_OVERRIDE = 500;
export const MAX_DELEGATIONS = 50;
export const MAX_DELEGATION_ADMINS = 200;
export const MAX_JURISDICTION_PREDICATES = 50;

export const OVERRIDE_ID_RE = /^lim-[0-9a-f]{12}$/;

const dimension = z
  .string()
  .min(1)
  .max(64)
  .refine((v) => DIMENSION_RE.test(v.toLowerCase()), {
    message: 'Invalid model/series qualifier',
  });

const entryBase = z.object({
  limitKey: z.string().refine((k) => LIMIT_KEYS.has(k), {
    message: 'Unknown limit key',
  }),
  modelId: dimension.optional(),
  series: dimension.optional(),
  value: z.union([
    z.number().int().nonnegative().max(1_000_000_000),
    z.null(),
    z.boolean(),
  ]),
});

type EntryLike = z.infer<typeof entryBase>;

/** The three cross-field rules every entry write obeys, whatever its `ceiling` shape. */
function refineEntry<E extends EntryLike>(schema: z.ZodType<E>): z.ZodType<E> {
  return schema
    .refine((e) => !(e.modelId && e.series), {
      message: 'An entry may carry at most one of modelId / series',
    })
    .refine((e) => !e.modelId || getLimitDefinition(e.limitKey)?.perModel, {
      message: 'This limit cannot be qualified by a model',
    })
    .refine((e) => !e.series || getLimitDefinition(e.limitKey)?.perModel, {
      message: 'This limit cannot be qualified by a series',
    });
}

/** Global write: `ceiling` is the global admin's pin (design §3c). */
export const entrySchema = refineEntry(
  entryBase.extend({ ceiling: z.boolean().default(false) }),
);
export type WriteEntry = z.infer<typeof entrySchema>;

/**
 * Scoped write: `ceiling` may only ever be absent or `false` — a scoped admin
 * cannot pin a cell (design §4), and the resolver ignores the flag on a
 * scoped record whatever is stored. Strict, so a stray key is an error the
 * editor can see rather than something silently stripped.
 */
export const scopedEntrySchema = refineEntry(
  entryBase.extend({ ceiling: z.literal(false).optional() }).strict(),
);

export const overrideSchema = z.object({
  id: z.string().regex(OVERRIDE_ID_RE),
  label: z.string().max(200).default(''),
  enabled: z.boolean().default(true),
  scope: z.enum(['user', 'domain', 'attribute', 'group']),
  targets: z.array(z.string().min(1).max(320)).max(MAX_TARGETS_PER_OVERRIDE),
  priority: z.number().int().min(-1000).max(1000).default(0),
  /** Present ⇒ scoped tier; must name a delegation in the same document. */
  delegationId: z.string().regex(DELEGATION_ID_RE).optional(),
  entries: z.array(entrySchema).max(MAX_ENTRIES_PER_OVERRIDE),
});
export type WriteOverride = z.infer<typeof overrideSchema>;

/**
 * The scoped body carries NO `delegationId` (it comes from the verified query
 * parameter), NO `createdBy`, and `priority` only as the literal 0 — the
 * server sets everything else. Strict: closing the escalation surface by
 * shape, not by intent.
 */
export const scopedOverrideBodySchema = z
  .object({
    id: z.string().regex(OVERRIDE_ID_RE),
    label: z.string().max(200).default(''),
    enabled: z.boolean().default(true),
    scope: z.enum(['user', 'domain', 'attribute', 'group']),
    targets: z.array(z.string().min(1).max(320)).max(MAX_TARGETS_PER_OVERRIDE),
    priority: z.literal(0).optional(),
    entries: z.array(scopedEntrySchema).max(MAX_ENTRIES_PER_OVERRIDE),
  })
  .strict();
export type ScopedOverrideBody = z.infer<typeof scopedOverrideBodySchema>;

export const jurisdictionPredicateWriteSchema = z
  .object({
    scope: z.enum(['user', 'domain', 'attribute', 'group']),
    targets: z
      .array(z.string().min(1).max(320))
      .min(1)
      .max(MAX_TARGETS_PER_OVERRIDE),
  })
  .strict();

/**
 * Delegation write schema. `id` absent → the server generates one; present →
 * it must be a `del-` id (a client may mint its own, like override ids).
 * `admins` are bounded here and canonicalized by the route.
 */
export const delegationWriteSchema = z
  .object({
    id: z.string().regex(DELEGATION_ID_RE).optional(),
    label: z.string().max(200).default(''),
    enabled: z.boolean().default(true),
    admins: z
      .array(z.string().min(3).max(320))
      .max(MAX_DELEGATION_ADMINS)
      .default([]),
    jurisdiction: z
      .array(jurisdictionPredicateWriteSchema)
      .max(MAX_JURISDICTION_PREDICATES)
      .default([]),
    maxOverrides: z.number().int().min(0).max(100).default(25),
  })
  .strict();
export type WriteDelegation = z.infer<typeof delegationWriteSchema>;

export const putBodySchema = z.object({
  defaults: z.array(entrySchema).max(500).default([]),
  overrides: z.array(overrideSchema).max(MAX_OVERRIDES).default([]),
  /**
   * OPTIONAL, not defaulted: the stale-client guard (design §9) must tell
   * "key omitted" from "empty list", and the route additionally checks raw
   * key presence because zod would erase it either way.
   */
  delegations: z.array(delegationWriteSchema).max(MAX_DELEGATIONS).optional(),
  mode: z.enum(['observe', 'enforce']).default('observe'),
  failMode: z.enum(['open', 'closed']).default('open'),
  timezone: z.string().min(1).max(64).default('UTC'),
  countByomUsage: z.boolean().default(false),
  countAuxiliaryUsage: z.boolean().default(false),
});

/**
 * Clamps every entry to its compiled hardCeiling at the WRITE boundary, so a
 * stored policy can never claim a value the resolver would silently reduce —
 * an admin must see the number that will actually apply.
 */
export function clampToHardCeilings<
  T extends { limitKey: string; value: number | boolean | null },
>(entries: T[]): T[] {
  return entries.map((entry) => {
    const def = getLimitDefinition(entry.limitKey);
    if (
      def?.hardCeiling !== undefined &&
      typeof entry.value === 'number' &&
      entry.value > def.hardCeiling
    ) {
      return { ...entry, value: def.hardCeiling };
    }
    return entry;
  });
}

/** Rejects an unresolvable timezone rather than storing a silent UTC fallback. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Formats zod issues the way every limits route reports them. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}
