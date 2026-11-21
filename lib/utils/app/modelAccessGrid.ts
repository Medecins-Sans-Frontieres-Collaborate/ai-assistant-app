/**
 * The model access GRID (docs/LIMITS.md "Model approval"): the same rules
 * the tree edits, read as one table. Rows are families and their models;
 * columns are "everyone else", one per group or domain named anywhere, and
 * the named people. Groups, domains and people are ONE kind of thing here
 * (an {@link Audience}) with one kind of answer ({@link AudienceTerms}); the
 * stored rule keeps a grant list and a block list per kind, and nothing
 * outside this module needs to know which list an entry lives on.
 *
 * Pure and client-importable. Inheritance convention, stated once here: a
 * MODEL row with nothing of its own in a column shows what its FAMILY sets
 * there, marked inherited; a family row with nothing shows empty.
 */
import type {
  LimitEntry,
  ModelAccessDefault,
  ModelAccessGrant,
  ModelAccessRule,
} from '@/lib/services/limits/types';

import {
  AccessState,
  ModelAccessDimension,
  effectiveAccessFor,
  emptyRule,
  ruleFor,
  upsertRule,
} from '@/lib/utils/app/modelAccessTree';

/** Who an entry is about: a person (mail), an Entra group or a domain. */
export interface Audience {
  scope: 'user' | 'group' | 'domain';
  /** Mail, Entra group object id or bare email domain, as stored. */
  target: string;
}

/**
 * The terms one audience gets on one row. Convention, stated once: a number
 * is a daily request cap, `null` is unlimited, `false` is BLOCKED.
 * `undefined` (only as an argument) means "no entry": remove it.
 */
export type AudienceTerms = number | null | false;

/** A group or a domain: the audiences the grid gives a column each. */
export interface AudienceColumn extends Audience {
  scope: 'group' | 'domain';
}

type GrantList = 'groups' | 'domains' | 'allow';
type BlockList = 'denyGroups' | 'denyDomains' | 'deny';

const GRANT_LIST: Record<Audience['scope'], GrantList> = {
  group: 'groups',
  domain: 'domains',
  user: 'allow',
};
const BLOCK_LIST: Record<Audience['scope'], BlockList> = {
  group: 'denyGroups',
  domain: 'denyDomains',
  user: 'deny',
};
/** Display order: the broadest lever an admin reaches for first. */
const SCOPES: readonly Audience['scope'][] = ['group', 'domain', 'user'];

const canonical = (target: string): string => target.trim().toLowerCase();

const sameTarget = (a: string, b: string): boolean =>
  canonical(a) === canonical(b);

/** Identity of an audience, for keys and de-duplication. */
export function audienceId(audience: Audience): string {
  return `${audience.scope}:${canonical(audience.target)}`;
}

/** Identity of a column, for keys and de-duplication. */
export const columnId: (column: AudienceColumn) => string = audienceId;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Reads one typed or pasted entry as an audience: `name@example.org` is a
 * person, `example.org` or `@example.org` a domain, a GUID an Entra group.
 *
 * @returns The audience with a canonical (trimmed, lowercased) target, or
 *   `null` when the text is none of the three.
 */
export function parseAudience(text: string): Audience | null {
  const value = canonical(text);
  if (GUID.test(value)) return { scope: 'group', target: value };
  const at = value.lastIndexOf('@');
  const domain = value.slice(at + 1);
  if (!DOMAIN.test(domain)) return null;
  if (at <= 0) return { scope: 'domain', target: domain };
  const local = value.slice(0, at);
  return /^[^\s@]+$/.test(local) ? { scope: 'user', target: value } : null;
}

/** The terms a rule itself gives an audience, or `undefined` for none. */
function ownTerms(
  rule: ModelAccessRule | undefined,
  audience: Audience,
): AudienceTerms | undefined {
  if (!rule) return undefined;
  const blocked = rule[BLOCK_LIST[audience.scope]] ?? [];
  if (blocked.some((target) => sameTarget(target, audience.target))) {
    return false;
  }
  return rule[GRANT_LIST[audience.scope]].find((grant: ModelAccessGrant) =>
    sameTarget(grant.target, audience.target),
  )?.requests;
}

/** Every audience a rule names, grants then blocks, in stored order. */
function audiencesOf(
  rule: ModelAccessRule,
  scope: Audience['scope'],
): string[] {
  return [
    ...rule[GRANT_LIST[scope]].map((grant) => grant.target),
    ...(rule[BLOCK_LIST[scope]] ?? []),
  ];
}

/**
 * Every audience column the grid shows: each group and domain granted or
 * blocked by any rule, then columns added this session that hold nothing
 * yet. Groups come before domains (more specific first); order within a
 * kind is first appearance, so adding an entry never reshuffles the table.
 */
export function audienceColumns(
  rules: readonly ModelAccessRule[],
  extra: readonly AudienceColumn[] = [],
): AudienceColumn[] {
  const seen = new Set<string>();
  const out: AudienceColumn[] = [];
  const add = (column: AudienceColumn) => {
    const id = columnId(column);
    if (!column.target.trim() || seen.has(id)) return;
    seen.add(id);
    out.push(column);
  };
  for (const scope of ['group', 'domain'] as const) {
    for (const rule of rules) {
      for (const target of audiencesOf(rule, scope)) add({ scope, target });
    }
    for (const column of extra) if (column.scope === scope) add(column);
  }
  return out;
}

/** What one cell of the grid holds. */
export type GridCell =
  /** Nothing here and nothing inherited. */
  | { kind: 'empty' }
  /** Set on this row. */
  | { kind: 'set'; terms: AudienceTerms }
  /** A model row showing what its family sets. */
  | { kind: 'inherited'; terms: AudienceTerms };

/**
 * The cell for one row and one audience: what that audience really gets.
 * A block wins wherever it sits (the resolver ranks it above a grant at the
 * same layer), so a model row whose FAMILY blocks the audience shows the
 * family's block even when the model grants it.
 *
 * @param dim - The row (a model id or a family series).
 * @param series - The model's family, for a model row.
 */
export function audienceCell(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  series: string | undefined,
  audience: Audience,
): GridCell {
  const own = ownTerms(ruleFor(rules, dim), audience);
  const family =
    dim.modelId && series
      ? ownTerms(ruleFor(rules, { series }), audience)
      : undefined;
  if (own === false) return { kind: 'set', terms: false };
  if (family === false) return { kind: 'inherited', terms: false };
  if (own !== undefined) return { kind: 'set', terms: own };
  if (family !== undefined) return { kind: 'inherited', terms: family };
  return { kind: 'empty' };
}

/** One line of a row's audience list. */
export interface AudienceEntry {
  audience: Audience;
  terms: AudienceTerms;
  /** `own`: set on this row. `family`: a model row showing its family's. */
  origin: 'own' | 'family';
  /** An own grant that does nothing because the family blocks the audience. */
  overruled: boolean;
}

/**
 * Everyone a row names, in one list: its own groups, domains and people,
 * then (for a model) the family's entries it has none of its own for.
 */
export function audienceEntries(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  series: string | undefined,
): AudienceEntry[] {
  const own = ruleFor(rules, dim);
  const family = dim.modelId && series ? ruleFor(rules, { series }) : undefined;
  const entries: AudienceEntry[] = [];
  const seen = new Set<string>();
  for (const [rule, origin] of [
    [own, 'own'],
    [family, 'family'],
  ] as const) {
    if (!rule) continue;
    for (const scope of SCOPES) {
      for (const target of audiencesOf(rule, scope)) {
        const audience: Audience = { scope, target };
        const id = audienceId(audience);
        if (seen.has(id)) continue;
        seen.add(id);
        const terms = ownTerms(rule, audience);
        if (terms === undefined) continue;
        entries.push({
          audience,
          terms,
          origin,
          overruled:
            origin === 'own' &&
            terms !== false &&
            ownTerms(family, audience) === false,
        });
      }
    }
  }
  return entries;
}

/**
 * Sets, changes or removes what one audience gets on one row. An audience
 * holds one entry per row: granting removes its block and blocking removes
 * its grant (the save refuses a target on both lists).
 *
 * @param terms - A daily cap, `null` for unlimited, `false` to block, or
 *   `undefined` to remove the entry (the row then inherits or has none).
 * @returns The new rule list; a rule left saying nothing is removed.
 */
export function withAudienceTerms(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  audience: Audience,
  terms: AudienceTerms | undefined,
): ModelAccessRule[] {
  const target = canonical(audience.target);
  if (!target) return [...rules];
  const grantList = GRANT_LIST[audience.scope];
  const blockList = BLOCK_LIST[audience.scope];
  const current = ruleFor(rules, dim) ?? emptyRule(dim);
  const grants = current[grantList];
  const existing = grants.find((grant) => sameTarget(grant.target, target));
  const otherGrants = grants.filter((grant) => grant !== existing);
  const otherBlocks = (current[blockList] ?? []).filter(
    (blocked) => !sameTarget(blocked, target),
  );
  const granted = terms !== undefined && terms !== false;
  const nextGrants = !granted
    ? otherGrants
    : existing
      ? grants.map((grant) =>
          grant === existing ? { ...grant, requests: terms } : grant,
        )
      : [...grants, { target, requests: terms }];
  const nextBlocks = terms === false ? [...otherBlocks, target] : otherBlocks;
  const { [blockList]: _blocks, ...rest } = current;
  return upsertRule(rules, dim, {
    ...rest,
    [grantList]: nextGrants,
    // The people block list is always stored; the group and domain ones
    // only when they hold something (older rules never carried them).
    ...(blockList === 'deny' || nextBlocks.length > 0
      ? { [blockList]: nextBlocks }
      : {}),
  } as ModelAccessRule);
}

/**
 * Gives several audiences the same terms on several rows in one step.
 *
 * @example
 * // Open two families to a group and a domain, 50 requests a day each.
 * withAudiencesTerms(rules, [{ series: 'claude' }, { series: 'gpt' }],
 *   [{ scope: 'group', target: id }, { scope: 'domain', target: 'msf.org' }], 50);
 */
export function withAudiencesTerms(
  rules: readonly ModelAccessRule[],
  dims: readonly ModelAccessDimension[],
  audiences: readonly Audience[],
  terms: AudienceTerms | undefined,
): ModelAccessRule[] {
  let next = [...rules];
  for (const dim of dims) {
    for (const audience of audiences) {
      next = withAudienceTerms(next, dim, audience, terms);
    }
  }
  return next;
}

/**
 * Sets the "everyone else" default of one row.
 *
 * @param value - `undefined` inherits, `false` makes it unavailable, `null`
 *   unlimited, a number a daily cap.
 */
export function withDefaultAccess(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  value: ModelAccessDefault | undefined,
): ModelAccessRule[] {
  const { defaultAccess: _dropped, ...rest } =
    ruleFor(rules, dim) ?? emptyRule(dim);
  return upsertRule(
    rules,
    dim,
    value === undefined ? rest : { ...rest, defaultAccess: value },
  );
}

/** The named people of a row, with what a model row inherits. */
export interface PeopleCounts {
  allowed: number;
  blocked: number;
  /** Family entries a model row has none of its own for. */
  inheritedAllowed: number;
  inheritedBlocked: number;
}

/** Counts the people a row names, own and inherited, granted and blocked. */
export function peopleCounts(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  series: string | undefined,
): PeopleCounts {
  const counts: PeopleCounts = {
    allowed: 0,
    blocked: 0,
    inheritedAllowed: 0,
    inheritedBlocked: 0,
  };
  for (const entry of audienceEntries(rules, dim, series)) {
    if (entry.audience.scope !== 'user') continue;
    const blocked = entry.terms === false;
    if (entry.origin === 'own') counts[blocked ? 'blocked' : 'allowed'] += 1;
    else counts[blocked ? 'inheritedBlocked' : 'inheritedAllowed'] += 1;
  }
  return counts;
}

/** How many audiences of each kind a summary names. */
export interface AudienceCounts {
  groups: number;
  domains: number;
  people: number;
}

/** Who can use a row, in summary. */
export type Reach =
  /** Open to everyone. */
  | { kind: 'everyone' }
  /** Open to everyone except the blocked audiences. */
  | ({ kind: 'everyoneBut' } & AudienceCounts)
  /** Closed by default; only the granted audiences. */
  | ({ kind: 'listed' } & AudienceCounts)
  /** Closed by default with nobody granted. */
  | { kind: 'nobody' };

/**
 * Who can use a row: the effective default for everyone else, then what the
 * row's audiences really get ({@link audienceCell}, so a family block counts
 * on its models and an overruled grant does not).
 */
export function reachOf(
  rules: readonly ModelAccessRule[],
  defaults: readonly LimitEntry[],
  dim: ModelAccessDimension,
  series: string | undefined,
): Reach {
  const state: AccessState = effectiveAccessFor(
    dim,
    series,
    defaults,
    rules,
  ).state;
  const open = state.kind !== 'unavailable';
  const counts: AudienceCounts = { groups: 0, domains: 0, people: 0 };
  const key = { group: 'groups', domain: 'domains', user: 'people' } as const;
  for (const { audience } of audienceEntries(rules, dim, series)) {
    const cell = audienceCell(rules, dim, series, audience);
    if (cell.kind === 'empty') continue;
    // Open rows are summed up by who is shut out, closed rows by who is in.
    if ((cell.terms === false) === open) counts[key[audience.scope]] += 1;
  }
  const none = counts.groups + counts.domains + counts.people === 0;
  if (open)
    return none ? { kind: 'everyone' } : { kind: 'everyoneBut', ...counts };
  return none ? { kind: 'nobody' } : { kind: 'listed', ...counts };
}
