/**
 * Access control for Grants Processing.
 *
 * Access is granted by Entra ID directory attributes.
 * The rule combines department with a title keyword — the
 * only subunit-level signal Entra carries for these teams:
 *
 *   MSF-USA AND (
 *     department "Program" with "grants" in the job title      // grants team
 *     OR department "Systems" with "innovation" in the title   // Product & Innovation
 *   )
 *
 * Values come from the user's Entra profile via the sign-in flow (auth.ts),
 * so access follows the directory: a title/department change takes effect at
 * the person's next sign-in. Enforced both server-side (every grants API
 * route calls canAccessGrants on the session user) and client-side (menu
 * visibility and the grants page redirect).
 */

export interface GrantsUser {
  department?: string | null;
  jobTitle?: string | null;
  companyName?: string | null;
}

/** department (lowercase) -> job-title keywords (lowercase), any of which
 *  qualifies a member of that department. */
const GRANTS_DEPARTMENT_TITLE_RULES: Record<string, string[]> = {
  program: ['grants'],
  systems: ['innovation'],
};

const GRANTS_ALLOWED_ORGS = new Set<string>(['msf-usa']);

function norm(value?: string | null): string {
  return (value || '').trim().toLowerCase();
}

// True if the given user is allowed to use the Grants Processing feature.
export function canAccessGrants(user?: GrantsUser | null): boolean {
  if (!user) return false;
  if (!GRANTS_ALLOWED_ORGS.has(norm(user.companyName))) return false;
  const titleKeywords = GRANTS_DEPARTMENT_TITLE_RULES[norm(user.department)];
  if (!titleKeywords) return false;
  const title = norm(user.jobTitle);
  return titleKeywords.some((kw) => title.includes(kw));
}
