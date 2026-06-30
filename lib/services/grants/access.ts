/**
 * Access control for the Grants Processing feature.
 *
 * The grants pipeline is restricted to a small allowlist of users (the MSF-USA
 * grants team, plus anyone explicitly added for testing). This is enforced
 * BOTH server-side (every grants API route calls requireGrantsAccess) and
 * client-side (the chat "Expand Actions" menu item and the grants page use
 * canAccessGrants to decide visibility/redirect).
 *
 * Matching is by display name OR email (case-insensitive). Email is the more
 * stable identifier — prefer it once an address is known. To grant or revoke
 * access, edit the two sets below; no other code needs to change.
 */

export interface GrantsUser {
  displayName?: string | null;
  mail?: string | null;
  email?: string | null;
  department?: string | null;
}

// Allowlisted display names (lowercase). Used when an email isn't known.
const GRANTS_ALLOWED_DISPLAY_NAMES = new Set<string>([
  'nelli ayvazyan',
  'mary vonckx',
  'christopher graham',
]);

// Allowlisted emails (lowercase). Preferred identifier — add the grants team's
// emails here when known and they take precedence over name matching.
const GRANTS_ALLOWED_EMAILS = new Set<string>([
  'nelli.ayvazyan@newyork.msf.org',
  'mary.vonckx@newyork.msf.org',
  'christopher.graham@newyork.msf.org',
]);

function norm(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

/** True if the given user is allowed to use the Grants Processing feature. */
export function canAccessGrants(user?: GrantsUser | null): boolean {
  if (!user) return false;
  const email = norm(user.mail ?? user.email);
  if (email && GRANTS_ALLOWED_EMAILS.has(email)) return true;
  const name = norm(user.displayName);
  if (name && GRANTS_ALLOWED_DISPLAY_NAMES.has(name)) return true;
  return false;
}
