/**
 * Access control for the Procurement RFP Scorecard feature.
 *
 * The RFP pipeline is restricted to a small allowlist of users (the developer
 * and the procurement stakeholder). This is enforced BOTH server-side (every
 * procurement API route and the procurement layout check requireProcurementAccess)
 * and client-side (the chat "Expand Actions" menu item uses canAccessProcurement
 * to decide visibility).
 *
 * Matching is by display name OR email (case-insensitive). Email is the more
 * stable identifier — prefer it once an address is known. To grant or revoke
 * access, edit the two sets below; no other code needs to change.
 *
 * (Same pattern as lib/services/grants/access.ts.)
 */

export interface ProcurementUser {
  displayName?: string | null;
  mail?: string | null;
  email?: string | null;
  department?: string | null;
}

// Allowlisted display names (lowercase). Used when an email isn't known.
const PROCUREMENT_ALLOWED_DISPLAY_NAMES = new Set<string>([
  'christopher graham',
  'arthi nithi',
]);

// Allowlisted emails (lowercase). Preferred identifier — these take
// precedence over name matching.
const PROCUREMENT_ALLOWED_EMAILS = new Set<string>([
  'christopher.graham@newyork.msf.org',
  'arthi.nithi@newyork.msf.org',
]);

function norm(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

/** True if the given user is allowed to use the RFP Scorecard feature. */
export function canAccessProcurement(user?: ProcurementUser | null): boolean {
  if (!user) return false;
  const email = norm(user.mail ?? user.email);
  if (email && PROCUREMENT_ALLOWED_EMAILS.has(email)) return true;
  const name = norm(user.displayName);
  if (name && PROCUREMENT_ALLOWED_DISPLAY_NAMES.has(name)) return true;
  return false;
}
