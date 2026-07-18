/**
 * Admin identity resolution for agent access control.
 *
 * Global admins come from the AGENT_ACCESS_ADMINS env var (bootstrap
 * mechanism, redeploy to change); local admins are delegated per canonical
 * agent key via config.json (editable by global admins in the UI, no
 * redeploy). All matching is on lowercased + trimmed Graph `mail` values.
 */
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

export function isGlobalAdmin(mail: string | null | undefined): boolean {
  if (!mail) return false;
  return parseGlobalAdminEmails().includes(mail.trim().toLowerCase());
}

export function resolveAdminStatus(
  mail: string | null | undefined,
  config: AgentAccessConfig | null,
): AdminStatus {
  if (isGlobalAdmin(mail)) {
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
  for (const admin of config.localAdmins) {
    if (admin.email.trim().toLowerCase() === normalized) {
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
    isLocalAdmin: keys.size > 0,
    editableAgentKeys: [...keys],
  };
}
