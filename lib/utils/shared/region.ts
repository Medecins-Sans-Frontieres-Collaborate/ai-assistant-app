/**
 * Shared region helpers — safe to import from both client and server code.
 *
 * Region ('US' | 'EU') decides which regional data plane a request is routed
 * to (blob storage + Azure AI Foundry endpoint) for data-residency reasons.
 * The authoritative resolved region lives on `session.user.region` (see auth.ts);
 * this module only holds the pure constants/parsers that both sides share, so
 * there is a single definition of the override cookie/param and how a region
 * string is validated.
 */

export type UserRegion = 'US' | 'EU';

/**
 * Cookie that carries a manual region override for testing/diagnostics.
 *
 * Deliberately NOT httpOnly: the client reads it to render the override
 * warning banner without a round-trip, and the server reads it in the auth
 * session callback to route the user's data to the overridden region.
 */
export const REGION_OVERRIDE_COOKIE = 'region_override';

/** URL query param that activates (or clears) a region override. */
export const REGION_OVERRIDE_PARAM = 'regionOverride';

/** Param value that clears an existing override. */
export const REGION_OVERRIDE_CLEAR = 'clear';

/**
 * Parses an arbitrary value into a valid {@link UserRegion}, or null when it is
 * absent/unrecognized. Case-insensitive and whitespace-tolerant so it can be
 * used directly on raw cookie or query-param values.
 */
export function parseRegion(
  value: string | null | undefined,
): UserRegion | null {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  return v === 'US' || v === 'EU' ? v : null;
}
