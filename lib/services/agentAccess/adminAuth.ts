/**
 * Admin identity resolution for agent access control.
 *
 * Global admins = the AGENT_ACCESS_ADMINS env var (bootstrap, un-lockable:
 * changing it needs a redeploy, and no runtime write can remove it) ∪ the
 * config roster `system/admin/global-admins.json` (editable by global admins
 * in the UI, design docs/LIMITS_SCOPED_ADMINS_DESIGN.md §13). Local admins are
 * delegated per canonical agent key via config.json. All matching is on
 * lowercased + trimmed Graph `mail` values.
 *
 * This module stays SYNCHRONOUS and free of storage imports: the config
 * roster is read from the pure snapshot in
 * lib/services/admin/globalAdminsSnapshot.ts, which the Node-only
 * GlobalAdminRosterService publishes into and the `auth()` session callback
 * warms once per request. Cold snapshot = env-only, which can fail to
 * recognise a config admin but can never grant.
 */
import { isConfigGlobalAdmin } from '@/lib/services/admin/globalAdminsSnapshot';
import { ViewAsAdminRole } from '@/lib/services/admin/viewAsTypes';
import { AgentAccessConfig } from '@/lib/services/agentAccess/types';

import { env } from '@/config/environment';

/** Sentinel for global admins: editable keys = every canonical key. */
export const ALL_AGENT_KEYS = '*' as const;

export interface AdminStatus {
  isGlobalAdmin: boolean;
  isLocalAdmin: boolean;
  /**
   * '*' (ALL_AGENT_KEYS) for global admins; otherwise the canonical keys
   * delegated to this local admin (empty for non-admins).
   */
  editableAgentKeys: typeof ALL_AGENT_KEYS | string[];
}

export function parseGlobalAdminEmails(
  raw: string | undefined = env.AGENT_ACCESS_ADMINS,
): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

/**
 * The session user, or whatever structurally carries the same two fields.
 * Passing the USER (rather than its bare mail) is what makes "view as"
 * (lib/services/admin/viewAsTypes.ts) reach every admin gate: an admin
 * viewing as a local admin or a regular user is answered as that role.
 */
export interface AdminSubject {
  mail?: string | null;
  viewAs?: {
    overrides: {
      adminRole?: ViewAsAdminRole;
      localAdminKeys?: string[];
      /**
       * Limits delegations the demoted admin is treated as named in (design
       * §6d); honoured only with adminRole 'local', by
       * lib/services/limits/limitsAdminAuth.ts — never by this module.
       */
      limitDelegationIds?: string[];
    };
  } | null;
}

/**
 * A bare mail string is the REAL-identity form: it ignores any view-as
 * demotion. Use it only where the real identity is the point — the view-as
 * controls themselves, and the admin rail entry that leads back to them.
 */
export type AdminIdentity = string | null | undefined | AdminSubject;

/** The mail an identity carries, whichever form it takes. */
export function mailOf(identity: AdminIdentity): string | null | undefined {
  return typeof identity === 'object' && identity !== null
    ? identity.mail
    : identity;
}

/**
 * The view-as demotion in force, if any. 'global' is not a demotion and never
 * reaches callers; a bare mail never carries one.
 */
export function demotedRole(
  identity: AdminIdentity,
): Extract<ViewAsAdminRole, 'local' | 'none'> | undefined {
  if (typeof identity !== 'object' || identity === null) return undefined;
  const role = identity.viewAs?.overrides.adminRole;
  return role === 'local' || role === 'none' ? role : undefined;
}

/**
 * REAL global-admin membership (view-as ignored): env roster ∪ config roster
 * snapshot. Env is consulted first so the bootstrap works before the roster
 * has ever loaded.
 */
export function isRealGlobalAdmin(mail: string | null | undefined): boolean {
  const normalized = mail?.trim().toLowerCase();
  if (!normalized) return false;
  if (parseGlobalAdminEmails().includes(normalized)) return true;
  return isConfigGlobalAdmin(normalized);
}

export function isGlobalAdmin(identity: AdminIdentity): boolean {
  if (demotedRole(identity)) return false;
  return isRealGlobalAdmin(mailOf(identity));
}

export function resolveAdminStatus(
  identity: AdminIdentity,
  config: AgentAccessConfig | null,
): AdminStatus {
  const mail = mailOf(identity);
  const demoted = demotedRole(identity);
  if (demoted && isRealGlobalAdmin(mail)) {
    // View-as demotion applies only to a real global admin (the cookie is
    // never honoured for anyone else — see readViewAs — but be explicit).
    if (demoted === 'none') {
      return {
        isGlobalAdmin: false,
        isLocalAdmin: false,
        editableAgentKeys: [],
      };
    }
    const keys = (
      typeof identity === 'object' && identity !== null
        ? (identity.viewAs?.overrides.localAdminKeys ?? [])
        : []
    ).map((key) => key.trim().toLowerCase());
    return {
      isGlobalAdmin: false,
      isLocalAdmin: true,
      editableAgentKeys: [...new Set(keys)],
    };
  }
  if (isRealGlobalAdmin(mail)) {
    return {
      isGlobalAdmin: true,
      isLocalAdmin: false,
      editableAgentKeys: ALL_AGENT_KEYS,
    };
  }
  const normalized = mail?.trim().toLowerCase();
  if (!normalized || !config) {
    return { isGlobalAdmin: false, isLocalAdmin: false, editableAgentKeys: [] };
  }
  const keys = new Set<string>();
  let isLocalAdmin = false;
  for (const admin of config.localAdmins) {
    if (admin.email.trim().toLowerCase() === normalized) {
      // Membership alone confers local-admin status: a zero-key entry may
      // still create prompt agents (which auto-delegate on create) even
      // though canEditKey over [] denies every existing key.
      isLocalAdmin = true;
      for (const key of admin.agentKeys) {
        // Canonicalize: case/whitespace variants in config.json must match
        // the canonical keys clients filter against (server-side canEditKey
        // tolerates variants, but the /me payload is compared verbatim).
        keys.add(key.trim().toLowerCase());
      }
    }
  }
  return {
    isGlobalAdmin: false,
    isLocalAdmin,
    editableAgentKeys: [...keys],
  };
}
