/**
 * Config-based global admin roster — schema and blob paths.
 *
 * This is its OWN configuration (design docs/LIMITS_SCOPED_ADMINS_DESIGN.md
 * §13), deliberately separate from the agent-access delegation map
 * (`system/agent-access/config.json`, local admins) and from the limits
 * policy (`system/limits/policy.json`, scoped delegations). Collapsing it into
 * either would hand a lesser admin tier a write path to the list that decides
 * who the lesser tiers are.
 *
 * Semantics: `isGlobalAdmin` = env `AGENT_ACCESS_ADMINS` ∪ this roster. The
 * env roster is the un-lockable bootstrap: a cold or failed roster read
 * degrades to env-only, which can fail to recognise a config admin but can
 * never grant, and the PUT refuses to leave BOTH rosters empty.
 *
 * Pure module (zod only) so it is safe to import from anywhere; the storage
 * side lives in globalAdminsStore.ts and the cache in
 * GlobalAdminRosterService.ts. Read schema is permissive (defaults) so every
 * stored blob keeps parsing — the schema-evolution rule from
 * lib/services/agentAccess/types.ts; the write schema lives in the route.
 */
import { z } from 'zod';

/**
 * Fresh sibling prefix beside `system/agent-access/` and `system/limits/` —
 * never underneath `system/agent-access/rules/`, whose fail-closed listing
 * would treat an alien blob as a broken rule.
 */
export const GLOBAL_ADMINS_PREFIX = 'system/admin/';
export const GLOBAL_ADMINS_PATH = `${GLOBAL_ADMINS_PREFIX}global-admins.json`;
export const GLOBAL_ADMINS_HISTORY_PREFIX = `${GLOBAL_ADMINS_PREFIX}global-admins-history/`;

export const GlobalAdminRosterSchema = z.object({
  version: z.literal(1),
  /** Graph `mail` values, lowercased + trimmed (normalizeAdminMail). */
  admins: z.array(z.string()).default([]),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type GlobalAdminRoster = z.infer<typeof GlobalAdminRosterSchema>;

/** Immutable audit copy written beside every successful roster write. */
export const GlobalAdminRosterHistoryEntrySchema = z.object({
  version: z.literal(1),
  action: z.literal('upsert'),
  roster: GlobalAdminRosterSchema,
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type GlobalAdminRosterHistoryEntry = z.infer<
  typeof GlobalAdminRosterHistoryEntrySchema
>;

/** The one canonical form every roster comparison uses. */
export function normalizeAdminMail(mail: string): string {
  return mail.trim().toLowerCase();
}

/** Mirrors lib/services/limits/types.ts historyBlobPath (timestamp + author). */
export function globalAdminsHistoryBlobPath(
  updatedAt: string,
  updatedBy: string,
): string {
  const safeTimestamp = updatedAt.replace(/[^0-9A-Za-z.-]/g, '_');
  const safeUser = updatedBy.replace(/[^0-9A-Za-z.@-]/g, '_').slice(0, 64);
  return `${GLOBAL_ADMINS_HISTORY_PREFIX}${safeTimestamp}-${safeUser}.json`;
}
