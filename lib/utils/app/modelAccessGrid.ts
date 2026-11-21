/**
 * The model access GRID (docs/LIMITS.md "Model approval"): the same rules
 * the tree edits, read as one table. Rows are families and their models;
 * columns are "everyone else", one per group or domain that holds a grant
 * anywhere, the allow list and the block list.
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

/** A group or a domain that some row grants access to. */
export interface AudienceColumn {
  scope: 'group' | 'domain';
  /** Entra group object id or email domain, as stored. */
  target: string;
}

const LIST_OF: Record<AudienceColumn['scope'], 'groups' | 'domains'> = {
  group: 'groups',
  domain: 'domains',
};

const sameTarget = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** Identity of a column, for keys and de-duplication. */
export function columnId(column: AudienceColumn): string {
  return `${column.scope}:${column.target.trim().toLowerCase()}`;
}

/**
 * Every audience column the grid shows: each group and domain granted by
 * any rule, then columns added this session that hold no grant yet. Groups
 * come before domains (more specific first); order within a kind is first
 * appearance, so adding a grant never reshuffles the table.
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
      for (const grant of rule[LIST_OF[scope]]) {
        add({ scope, target: grant.target });
      }
    }
    for (const column of extra) if (column.scope === scope) add(column);
  }
  return out;
}

function grantOf(
  rule: ModelAccessRule | undefined,
  column: AudienceColumn,
): ModelAccessGrant | undefined {
  return rule?.[LIST_OF[column.scope]].find((grant) =>
    sameTarget(grant.target, column.target),
  );
}

/** What one cell of the grid holds. */
export type GridCell =
  /** Nothing here and nothing inherited. */
  | { kind: 'empty' }
  /** Set on this row. `requests: null` is unlimited. */
  | { kind: 'set'; requests: number | null }
  /** A model row showing its family's grant. */
  | { kind: 'inherited'; requests: number | null };

/**
 * The cell for one row and one audience column.
 *
 * @param dim - The row (a model id or a family series).
 * @param series - The model's family, for a model row.
 */
export function audienceCell(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  series: string | undefined,
  column: AudienceColumn,
): GridCell {
  const own = grantOf(ruleFor(rules, dim), column);
  if (own) return { kind: 'set', requests: own.requests };
  if (dim.modelId && series) {
    const family = grantOf(ruleFor(rules, { series }), column);
    if (family) return { kind: 'inherited', requests: family.requests };
  }
  return { kind: 'empty' };
}

/**
 * Sets, changes or removes one audience's grant on one row.
 *
 * @param requests - A daily cap, `null` for unlimited, or `undefined` to
 *   remove the grant (the row then inherits or has none).
 * @returns The new rule list; a rule left saying nothing is removed.
 */
export function withAudienceGrant(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  column: AudienceColumn,
  requests: number | null | undefined,
): ModelAccessRule[] {
  const list = LIST_OF[column.scope];
  const current = ruleFor(rules, dim) ?? emptyRule(dim);
  const rest = current[list].filter(
    (grant) => !sameTarget(grant.target, column.target),
  );
  const existing = grantOf(current, column);
  const grants =
    requests === undefined
      ? rest
      : existing
        ? current[list].map((grant) =>
            grant === existing ? { ...grant, requests } : grant,
          )
        : [...rest, { target: column.target.trim(), requests }];
  return upsertRule(rules, dim, { ...current, [list]: grants });
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

/** The people lists of a row, with what a model row inherits from its family. */
export interface PeopleLists {
  allow: number;
  deny: number;
  /** Family entries a model row inherits on top of its own. */
  inheritedAllow: number;
  inheritedDeny: number;
}

export function peopleLists(
  rules: readonly ModelAccessRule[],
  dim: ModelAccessDimension,
  series: string | undefined,
): PeopleLists {
  const own = ruleFor(rules, dim);
  const family = dim.modelId && series ? ruleFor(rules, { series }) : undefined;
  return {
    allow: own?.allow.length ?? 0,
    deny: own?.deny.length ?? 0,
    inheritedAllow: family?.allow.length ?? 0,
    inheritedDeny: family?.deny.length ?? 0,
  };
}

/** Who can use a row, in summary. */
export type Reach =
  /** Open to everyone. */
  | { kind: 'everyone' }
  /** Open to everyone except the people on a block list. */
  | { kind: 'everyoneBut'; blocked: number }
  /** Closed by default; only the listed audiences. */
  | { kind: 'listed'; groups: number; domains: number; people: number }
  /** Closed by default with nobody listed. */
  | { kind: 'nobody' };

/**
 * Who can use a row: the effective default for everyone else, then the
 * grants and blocks on the row and (for a model) on its family.
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
  const sources = [
    ruleFor(rules, dim),
    dim.modelId && series ? ruleFor(rules, { series }) : undefined,
  ].filter((rule): rule is ModelAccessRule => rule !== undefined);
  const distinct = (pick: (rule: ModelAccessRule) => string[]): number =>
    new Set(sources.flatMap(pick).map((value) => value.trim().toLowerCase()))
      .size;
  const blocked = distinct((rule) => rule.deny);
  if (state.kind !== 'unavailable') {
    return blocked > 0
      ? { kind: 'everyoneBut', blocked }
      : { kind: 'everyone' };
  }
  const groups = distinct((rule) => rule.groups.map((g) => g.target));
  const domains = distinct((rule) => rule.domains.map((g) => g.target));
  const people = distinct((rule) => rule.allow.map((g) => g.target));
  return groups + domains + people === 0
    ? { kind: 'nobody' }
    : { kind: 'listed', groups, domains, people };
}
