/**
 * Shared delegations (docs/ADMIN_ANNOUNCEMENTS_DESIGN.md §7).
 *
 * A delegation answers ONE question — whose users? (its jurisdiction) — and
 * each admin named in it holds individually chosen GRANTS. Until this module
 * a delegation existed only inside the usage-limits policy and could only
 * mean "scoped limits admin"; it is now a category of its own, stored in its
 * own document, and the limits policy is COMPOSED with it at read time
 * (lib/services/limits/limitsStore.ts).
 *
 * Why its own document rather than "keep it in the limits policy and let
 * other features read it": a stored limits policy ENFORCES even with the
 * `usageLimits` flag off, so creating one merely to delegate messaging would
 * switch limits enforcement on as a side effect.
 *
 * Two rules make "an admin that can do anything" safe:
 *  - `grants: 'all'` is bounded by the delegation's own `capabilities` — it
 *    means "everything THIS delegation offers", not everything the app will
 *    ever offer;
 *  - a capability is only ever added to a delegation by a global admin, so a
 *    grant type shipped later is never conferred silently on an existing
 *    `all` admin. (The one-time migration is the single, deliberate
 *    exception: it grants every capability that exists at that moment.)
 *
 * Client-importable: no server-only imports (the admin UI value-imports the
 * schemas), and `NEXT_PUBLIC_ENV` decides the beta variant exactly as it does
 * for the limits paths.
 */
import {
  DELEGATION_ID_RE,
  JurisdictionPredicateSchema,
  LimitDelegation,
  limitsBlobVariant,
} from '@/lib/services/limits/types';

import { z } from 'zod';

export const DELEGATION_GRANTS = ['limits', 'announcements'] as const;
export const DelegationGrantSchema = z.enum(DELEGATION_GRANTS);
export type DelegationGrant = z.infer<typeof DelegationGrantSchema>;

export const MAX_SHARED_DELEGATIONS = 50;
export const MAX_DELEGATION_ADMINS = 200;
export const DEFAULT_MAX_OVERRIDES = 25;

const DELEGATIONS_PREFIX = 'system/admin/';

/** Beta shares the admin container with prod — same suffix rule as limits. */
export function delegationsBlobPaths(variant: 'beta' | null): {
  documentPath: string;
  historyPrefix: string;
} {
  const suffix = variant ? `.${variant}` : '';
  return {
    documentPath: `${DELEGATIONS_PREFIX}delegations${suffix}.json`,
    historyPrefix: `${DELEGATIONS_PREFIX}delegations-history${suffix}/`,
  };
}

const ACTIVE_PATHS = delegationsBlobPaths(limitsBlobVariant());
export const DELEGATIONS_DOCUMENT_PATH = ACTIVE_PATHS.documentPath;
export const DELEGATIONS_HISTORY_PREFIX = ACTIVE_PATHS.historyPrefix;

export function delegationsHistoryBlobPath(
  updatedAt: string,
  updatedBy: string,
): string {
  const stamp = updatedAt.replace(/[:.]/g, '-');
  const who = updatedBy.replace(/[^a-z0-9@._-]/gi, '_');
  return `${DELEGATIONS_HISTORY_PREFIX}${stamp}_${who}.json`;
}

export const DelegationAdminSchema = z
  .object({
    /** Graph `mail`, lowercased. */
    mail: z.string().max(320),
    /** 'all' = every capability THIS delegation enables. */
    grants: z.union([z.literal('all'), z.array(DelegationGrantSchema)]),
  })
  .passthrough();
export type DelegationAdmin = z.infer<typeof DelegationAdminSchema>;

// `.passthrough()` + bounded-on-read, like the limits record schemas: an
// older replica's write must not strip a newer replica's fields, and a
// runaway document must fail loud here rather than in a hot path.
export const SharedDelegationSchema = z
  .object({
    id: z.string().regex(DELEGATION_ID_RE),
    label: z.string().default(''),
    /** Disabled → confers nothing, and everything authored under it is inert. */
    enabled: z.boolean().default(true),
    /** OR'd. Empty = matches nobody. */
    jurisdiction: z.array(JurisdictionPredicateSchema).max(50).default([]),
    /** What this delegation can confer at all. */
    capabilities: z.array(DelegationGrantSchema).default([]),
    admins: z
      .array(DelegationAdminSchema)
      .max(MAX_DELEGATION_ADMINS)
      .default([]),
    /** Settings of the `limits` capability. */
    limits: z
      .object({
        maxOverrides: z
          .number()
          .int()
          .min(0)
          .max(100)
          .default(DEFAULT_MAX_OVERRIDES),
      })
      .passthrough()
      .default({ maxOverrides: DEFAULT_MAX_OVERRIDES }),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type SharedDelegation = z.infer<typeof SharedDelegationSchema>;

export const DelegationsDocumentSchema = z
  .object({
    version: z.literal(1),
    delegations: z
      .array(SharedDelegationSchema)
      .max(MAX_SHARED_DELEGATIONS)
      .default([]),
    /** Set once, by the one-time move out of the limits policy. */
    migratedFromLimitsAt: z.string().optional(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type DelegationsDocument = z.infer<typeof DelegationsDocumentSchema>;

export const DelegationsHistoryEntrySchema = z.object({
  version: z.literal(1),
  document: DelegationsDocumentSchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type DelegationsHistoryEntry = z.infer<
  typeof DelegationsHistoryEntrySchema
>;

function canonicalMail(mail: string | null | undefined): string {
  return (mail ?? '').trim().toLowerCase();
}

/** Grants `admin` effectively holds: `capabilities ∩ grants`. */
export function effectiveGrants(
  delegation: Pick<SharedDelegation, 'capabilities' | 'enabled'>,
  admin: DelegationAdmin,
): DelegationGrant[] {
  if (!delegation.enabled) return [];
  return admin.grants === 'all'
    ? [...delegation.capabilities]
    : delegation.capabilities.filter((grant) =>
        (admin.grants as DelegationGrant[]).includes(grant),
      );
}

/** Whether `mail` holds `grant` in this delegation (enabled ones only). */
export function adminHoldsGrant(
  delegation: SharedDelegation,
  mail: string | null | undefined,
  grant: DelegationGrant,
): boolean {
  const normalized = canonicalMail(mail);
  if (!normalized) return false;
  return delegation.admins.some(
    (admin) =>
      canonicalMail(admin.mail) === normalized &&
      effectiveGrants(delegation, admin).includes(grant),
  );
}

/**
 * The limits feature's view of the shared delegations: only delegations that
 * offer `limits`, and only the admins who hold it. Everything in limits —
 * resolver, scoped write path, admin auth, verdicts — keeps consuming
 * `LimitDelegation[]` unchanged; this projection is the whole seam.
 *
 * `enabled` is carried as-is: a disabled delegation must still be PRESENT so
 * its overrides stay recognisably scoped-and-inert instead of looking like
 * orphans.
 */
export function toLimitDelegations(
  document: DelegationsDocument | null,
): LimitDelegation[] {
  return (document?.delegations ?? [])
    .filter((delegation) => delegation.capabilities.includes('limits'))
    .map((delegation) => ({
      id: delegation.id,
      label: delegation.label,
      enabled: delegation.enabled,
      admins: delegation.admins
        .filter(
          (admin) =>
            admin.grants === 'all' ||
            (admin.grants as DelegationGrant[]).includes('limits'),
        )
        .map((admin) => canonicalMail(admin.mail))
        .filter(Boolean),
      jurisdiction: delegation.jurisdiction,
      maxOverrides: delegation.limits.maxOverrides,
      createdBy: delegation.createdBy,
      createdAt: delegation.createdAt,
      updatedBy: delegation.updatedBy,
      updatedAt: delegation.updatedAt,
    }));
}

/**
 * One-time move out of the limits policy. By decision every existing delegate
 * receives FULL permissions on their delegation: each delegation gets every
 * capability that exists today and each admin `grants: 'all'`. Ids are kept —
 * stored overrides reference them.
 */
export function fromLegacyLimitDelegations(
  legacy: readonly LimitDelegation[],
  migratedBy: string,
  now: string,
): DelegationsDocument {
  return {
    version: 1,
    delegations: legacy.slice(0, MAX_SHARED_DELEGATIONS).map((delegation) => ({
      id: delegation.id,
      label: delegation.label,
      enabled: delegation.enabled,
      jurisdiction: delegation.jurisdiction,
      capabilities: [...DELEGATION_GRANTS],
      admins: [...new Set(delegation.admins.map(canonicalMail))]
        .filter(Boolean)
        .map((mail) => ({ mail, grants: 'all' as const })),
      limits: { maxOverrides: delegation.maxOverrides },
      createdBy: delegation.createdBy,
      createdAt: delegation.createdAt,
      updatedBy: delegation.updatedBy,
      updatedAt: delegation.updatedAt,
    })),
    migratedFromLimitsAt: now,
    updatedBy: migratedBy,
    updatedAt: now,
  };
}
