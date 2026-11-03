/**
 * `policy.groupLabels`: display names for every Entra group id a policy
 * document references, kept alongside the ids so a history snapshot can
 * still be read after a group is renamed or deleted, and so list views can
 * show names without a directory round trip.
 *
 * Maintained on the WRITE paths (global PUT, scoped upsert): the ids are
 * collected from the document about to be stored, names are fetched with
 * the writer's own delegated token through the batched, cached resolver in
 * lib/services/m365/groupDirectory.ts, and the map is pruned to referenced
 * ids. Best effort by construction — a Graph failure keeps the previous
 * label for an id and never fails the admin's save. Nothing on the
 * evaluation path reads this map.
 */
import { NextRequest } from 'next/server';

import {
  LimitDelegation,
  LimitOverride,
  ModelAccessRule,
} from '@/lib/services/limits/types';
import { isEntraGroupId } from '@/lib/services/shared/principalMatching';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/** Mirrors the read schema's bound on `groupLabels`. */
export const MAX_GROUP_LABELS = 2000;

export interface GroupBearingDocument {
  overrides?: readonly Pick<LimitOverride, 'scope' | 'targets'>[];
  delegations?: readonly Pick<LimitDelegation, 'jurisdiction'>[];
  modelAccess?: readonly Pick<ModelAccessRule, 'groups'>[];
}

/** Every distinct, well-formed group id the document targets, sorted. */
export function collectGroupIds(doc: GroupBearingDocument): string[] {
  const ids = new Set<string>();
  const add = (value: string) => {
    const id = value.trim().toLowerCase();
    if (isEntraGroupId(id)) ids.add(id);
  };
  for (const override of doc.overrides ?? []) {
    if (override.scope !== 'group') continue;
    for (const target of override.targets) add(target);
  }
  for (const delegation of doc.delegations ?? []) {
    for (const predicate of delegation.jurisdiction) {
      if (predicate.scope !== 'group') continue;
      for (const target of predicate.targets) add(target);
    }
  }
  for (const rule of doc.modelAccess ?? []) {
    for (const grant of rule.groups ?? []) add(grant.target);
  }
  return [...ids].sort();
}

/**
 * `labels` restricted to `ids`, keys sorted so two snapshots of the same
 * state serialize identically; `undefined` when nothing is left (the key is
 * then absent from the document rather than an empty object).
 */
export function pruneGroupLabels(
  labels: Record<string, string> | undefined,
  ids: readonly string[],
): Record<string, string> | undefined {
  if (!labels) return undefined;
  const out: Record<string, string> = {};
  for (const id of [...ids].sort().slice(0, MAX_GROUP_LABELS)) {
    const name = labels[id];
    if (typeof name === 'string' && name) out[id] = name.slice(0, 256);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Fresh labels for `ids`, falling back to `previous` for any id the
 * directory did not answer for (deleted group, Graph outage). Never throws.
 */
export async function refreshGroupLabels(
  req: NextRequest,
  ids: readonly string[],
  previous: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
  const wanted = [...new Set(ids)].filter(isEntraGroupId).sort();
  if (wanted.length === 0) return undefined;
  const merged: Record<string, string> = {};
  for (const id of wanted) {
    const old = previous?.[id];
    if (typeof old === 'string' && old) merged[id] = old;
  }
  try {
    // Lazy for the same reason groupMembership.ts is: graphApi pulls
    // next-auth, and this module is imported by routes whose tests stub it.
    const { fetchGroupNames } =
      await import('@/lib/services/m365/groupDirectory');
    const names = await fetchGroupNames(req, wanted);
    for (const [id, name] of names) merged[id] = name;
  } catch (error) {
    console.warn(
      `[limits-admin] group label refresh skipped: ${sanitizeForLog(
        error instanceof Error ? error.message.slice(0, 160) : 'unknown',
      )}`,
    );
  }
  return pruneGroupLabels(merged, wanted);
}
