/**
 * Shared principal matching for app-layer targeting rules — agent access
 * (`allowUsers` / `allowDomains` / `allowGroups`) and usage limits
 * (override `scope` + `targets`) must agree on what "this user matches this
 * rule" means, or an admin who understands one will misread the other.
 *
 * Pure and dependency-free: no node builtins, so client code may import it.
 *
 * ⚠ GROUPS ARE NOT EVALUATED. `Principal.groupIds` is always `[]` today —
 * Entra group membership is not on the session (auth.ts requests
 * `openid User.Read User.ReadBasic.all offline_access`, and there is no
 * `/me/memberOf` call anywhere), pending tenant consent. Group targets are
 * persisted and round-tripped so nothing is lost, but they grant and deny
 * nothing. See docs/M365_GRAPH_PERMISSIONS_REQUEST.md. The moment
 * `groupIds` is populated, both features light up through this function.
 */

/** Scopes an override/rule target list can be interpreted against. */
export type PrincipalScope = 'user' | 'domain' | 'attribute' | 'group';

export interface Principal {
  /**
   * Entra oid (`session.user.id`) — REQUIRED, and the key usage counters are
   * stored under. Deliberately NOT used for targeting: it is stable, whereas
   * `mail` is what admins actually type.
   */
  userId: string;
  /** Graph `mail`, lowercased/trimmed. Optional — not every identity has one. */
  mail?: string;
  /** Substring after the LAST '@' of `mail`, lowercased. */
  domain?: string;
  /** `department:<v>` | `company:<v>` | `office:<v>`, lowercased. */
  attributes: string[];
  /** Entra group object ids. ALWAYS empty today — see the module header. */
  groupIds: string[];
}

/** Lowercased + trimmed, or undefined when absent/blank. */
export function normalizeMail(
  mail: string | null | undefined,
): string | undefined {
  const normalized = mail?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

/**
 * The part after the LAST '@'. Exact-match only — deliberately NOT
 * `OfficeResolver`'s subdomain matcher: two mechanisms that disagree about
 * what a domain is would be impossible for an admin to reason about.
 */
export function domainOfMail(
  mail: string | null | undefined,
): string | undefined {
  const normalized = normalizeMail(mail);
  if (!normalized) return undefined;
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex < 0) return undefined;
  const domain = normalized.slice(atIndex + 1);
  return domain ? domain : undefined;
}

/** Case-insensitive exact membership. Blank `value` never matches. */
export function matchesTargets(
  targets: readonly string[],
  value: string | undefined,
): boolean {
  if (!value) return false;
  return targets.some((target) => target.trim().toLowerCase() === value);
}

/** Case-insensitive intersection. Empty `values` never matches. */
export function intersectsTargets(
  targets: readonly string[],
  values: readonly string[],
): boolean {
  if (values.length === 0) return false;
  const normalized = new Set(values.map((v) => v.trim().toLowerCase()));
  return targets.some((target) => normalized.has(target.trim().toLowerCase()));
}

/**
 * Does `principal` match `targets` interpreted under `scope`?
 *
 * A principal with no `mail` never matches a user or domain target — callers
 * decide what that means for them (agent access denies, since it is a
 * security control; limits fall back to global defaults, since denying chat
 * over a missing profile field would be an outage).
 */
export function matchesPrincipal(
  principal: Principal,
  scope: PrincipalScope,
  targets: readonly string[],
): boolean {
  if (targets.length === 0) return false;
  switch (scope) {
    case 'user':
      return matchesTargets(targets, principal.mail);
    case 'domain':
      return matchesTargets(targets, principal.domain);
    case 'attribute':
      return intersectsTargets(targets, principal.attributes);
    case 'group':
      // Always false today: groupIds is always []. Kept explicit rather than
      // `return false` so this activates the day membership lands.
      return intersectsTargets(targets, principal.groupIds);
  }
}
