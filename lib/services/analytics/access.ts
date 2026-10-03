/**
 * Who may open which analytics folder (design §6).
 *
 * DENY BY DEFAULT, by construction: a folder nobody configured has no
 * audience, `matchesPrincipal` returns false on empty targets, and the answer
 * is 'none'. This is deliberately NOT `AgentAccessService.evaluateAccess`,
 * which answers "allow" when there is no rule and when its env switch is off
 * — the wrong defaults for finance and per-user data.
 *
 * Pure: no storage imports.
 */
import { folderChain, isRawPath } from '@/lib/services/analytics/paths';
import {
  AnalyticsAccessLevel,
  AnalyticsFolder,
} from '@/lib/services/analytics/types';
import {
  Principal,
  matchesPrincipal,
} from '@/lib/services/shared/principalMatching';

export type FolderAccess = 'none' | AnalyticsAccessLevel | 'admin';

export interface AnalyticsActor {
  principal: Principal;
  /** Effective (view-as aware) global admin. */
  isGlobalAdmin: boolean;
  /** Global admin, or holder of the `analytics` delegation grant. */
  isAnalyticsAdmin: boolean;
}

export type FolderIndex = ReadonlyMap<string, AnalyticsFolder>;

export function indexFolders(
  folders: readonly AnalyticsFolder[] | null | undefined,
): FolderIndex {
  return new Map((folders ?? []).map((folder) => [folder.path, folder]));
}

const RANK: Record<FolderAccess, number> = {
  none: 0,
  view: 1,
  download: 2,
  admin: 3,
};

export function atLeast(access: FolderAccess, needed: FolderAccess): boolean {
  return RANK[access] >= RANK[needed];
}

/**
 * The access `actor` has to `folderPath`.
 *
 *  - `raw/…` is global admins only. Not delegated analytics admins, and no
 *    audience can change it: the check runs before any stored configuration
 *    is consulted.
 *  - Analytics admins get 'admin' everywhere else.
 *  - Everyone else gets the strongest level among the audience entries they
 *    match, collected from the folder up to the root and stopping after the
 *    first `restricted` folder (its own entries still apply).
 */
export function resolveFolderAccess(
  folderPath: string,
  folders: FolderIndex,
  actor: AnalyticsActor,
): FolderAccess {
  if (isRawPath(folderPath)) {
    return actor.isGlobalAdmin ? 'admin' : 'none';
  }
  if (actor.isAnalyticsAdmin) return 'admin';

  let best: FolderAccess = 'none';
  for (const path of folderChain(folderPath)) {
    const folder = folders.get(path);
    if (!folder) continue;
    for (const entry of folder.audience) {
      if (RANK[entry.level] <= RANK[best]) continue;
      if (matchesPrincipal(actor.principal, entry.scope, entry.targets)) {
        best = entry.level;
      }
    }
    if (folder.restricted) break;
  }
  return best;
}

/** Whether `actor` can open ANY folder — the cheap "show the entry" check. */
export function hasAnyAnalyticsAccess(
  folders: FolderIndex,
  actor: AnalyticsActor,
): boolean {
  if (actor.isAnalyticsAdmin) return true;
  for (const folder of folders.values()) {
    if (isRawPath(folder.path)) continue;
    if (
      folder.audience.some((entry) =>
        matchesPrincipal(actor.principal, entry.scope, entry.targets),
      )
    ) {
      return true;
    }
  }
  return false;
}
