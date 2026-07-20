/**
 * Entity-agnostic machinery shared by the admin CRUD routes under
 * /api/agent-access (prompt agents, MCP connectors, …).
 *
 * These behaviours are identical for every admin-authored record type because
 * they all hang off the same canonical-key namespace: per-key authorization,
 * CAS etag discipline, creator delegation, and the audit log. Extracted so a
 * new record type cannot quietly diverge on the security-relevant parts.
 *
 * NOTE: app/api/agent-access/prompt-agents/route.ts still carries its own
 * copies (it predates this module). Folding it in is a mechanical follow-up —
 * deliberately not done in the same change that introduced connectors, to
 * keep a reviewed route stable.
 */
import {
  AgentAccessConflictError,
  createAgentAccessBlobStorage,
  readConfig,
  writeConfig,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  ALL_AGENT_KEYS,
  AdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import { AgentAccessConfig } from '@/lib/services/agentAccess/types';

import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

/**
 * Only an exact quoted strong ETag may reach a storage CAS condition —
 * `If-Match: *` matches any blob and would reduce the CAS to a blind write,
 * and a weak validator (W/…) can never strong-match.
 */
export const STRONG_ETAG_REGEX = /^"[^"]*"$/;

/**
 * On a lost delegation CAS race the config is re-read and the append retried
 * this many times before the caller rolls the create back.
 */
const DELEGATION_CAS_ATTEMPTS = 3;

/** May this admin write the given canonical key? Keys are compared canonicalized. */
export function canEditKey(status: AdminStatus, canonicalKey: string): boolean {
  if (status.editableAgentKeys === ALL_AGENT_KEYS) return true;
  return status.editableAgentKeys.some(
    (key) => key.trim().toLowerCase() === canonicalKey,
  );
}

export function auditAdminWrite(
  action: string,
  canonicalKey: string,
  updatedBy: string,
): void {
  console.log(
    `[agent-access-admin] action=${sanitizeForLog(action)} key=${sanitizeForLog(canonicalKey)} by=${sanitizeForLog(updatedBy)}`,
  );
}

/**
 * Records a just-created record's canonical key on every localAdmins entry
 * matching the creator, so a local admin always ends up able to edit what
 * they created. CAS loop: on a lost race the config is re-read and the append
 * retried; any other failure (including a missing config/entry — the
 * delegation that authorized the create has vanished) returns false and the
 * caller must roll the create back.
 */
export async function delegateToCreator(
  userMail: string,
  canonicalKey: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= DELEGATION_CAS_ATTEMPTS; attempt++) {
    try {
      const storage = createAgentAccessBlobStorage();
      const configResult = await readConfig(storage);
      const matchesCreator = (email: string) =>
        email.trim().toLowerCase() === userMail;
      if (
        !configResult ||
        !configResult.config.localAdmins.some((a) => matchesCreator(a.email))
      ) {
        console.error(
          `[agent-access-admin] delegation failed: no localAdmins entry for ${sanitizeForLog(userMail)}`,
        );
        return false;
      }
      const updated: AgentAccessConfig = {
        version: 1,
        localAdmins: configResult.config.localAdmins.map((admin) =>
          matchesCreator(admin.email) &&
          !admin.agentKeys.some(
            (key) => key.trim().toLowerCase() === canonicalKey,
          )
            ? { ...admin, agentKeys: [...admin.agentKeys, canonicalKey] }
            : admin,
        ),
        updatedBy: userMail,
        updatedAt: new Date().toISOString(),
      };
      await writeConfig(storage, updated, configResult.etag);
      auditAdminWrite('delegate', canonicalKey, userMail);
      return true;
    } catch (error) {
      if (
        error instanceof AgentAccessConflictError &&
        attempt < DELEGATION_CAS_ATTEMPTS
      ) {
        // Another admin write won the CAS — re-read and retry.
        continue;
      }
      console.error(
        `[agent-access-admin] delegation write failed (attempt ${attempt}/${DELEGATION_CAS_ATTEMPTS}) for key=${sanitizeForLog(canonicalKey)}: ${sanitizeForLog(error)}`,
      );
      return false;
    }
  }
  return false;
}
