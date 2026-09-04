/**
 * Startup diagnostics for app-layer access control.
 *
 * `AGENT_ACCESS_CONTROL_ENABLED` and `AGENT_ACCESS_ADMINS` are deliberately
 * independent — the flag decides whether rules are READ, the roster decides
 * who may WRITE them — because deriving one from the other would mean a typo
 * in the admin list silently un-restricts every agent (disabled evaluates to
 * `allow`), and would make the documented break-glass ("set the flag false")
 * destroy the very credentials needed to recover.
 *
 * Independent knobs do, however, produce two combinations that are almost
 * certainly misconfigurations rather than intent. Nobody should have to
 * discover those by noticing that nothing happened, so we say so at boot.
 *
 * These WARN rather than fail startup: "enforcing with no global admins" is
 * legitimate when the delegation map carries local admins, and refusing to
 * boot on it would turn a cosmetic gap into an outage.
 */

export interface AccessControlStartupState {
  enabled: boolean;
  /**
   * Env roster (AGENT_ACCESS_ADMINS) + config roster
   * (system/admin/global-admins.json) — the union isGlobalAdmin evaluates.
   * When the config roster could not be read it contributes 0 here and
   * `globalRosterUnreadable` is set, so the wording can hedge.
   */
  globalAdminCount: number;
  /**
   * Local admins in config.json, or null when the config blob could not be
   * read. Null suppresses the "nobody can author" claim — we must not assert
   * an empty roster we were merely unable to observe.
   */
  localAdminCount: number | null;
  /**
   * True when the config global-admin roster could not be read at boot. Like
   * `localAdminCount: null`, this turns a definite "nobody can author" into a
   * hedge. Optional so the pure builder's existing callers/tests stay valid.
   */
  globalRosterUnreadable?: boolean;
}

/**
 * Returns the warnings this configuration deserves, most-actionable first.
 * Pure so the message wording is testable without a storage account.
 */
export function buildAccessControlWarnings(
  state: AccessControlStartupState,
): string[] {
  const warnings: string[] = [];

  if (!state.enabled && state.globalAdminCount > 0) {
    warnings.push(
      `AGENT_ACCESS_ADMINS and the global-admin roster list ${state.globalAdminCount} admin(s) but ` +
        'AGENT_ACCESS_CONTROL_ENABLED is false: no access rules are enforced, ' +
        'admin routes answer 404, and the admin UI is hidden. Set ' +
        'AGENT_ACCESS_CONTROL_ENABLED=true to activate access control.',
    );
  }

  if (state.enabled && state.globalAdminCount === 0) {
    if (state.globalRosterUnreadable) {
      warnings.push(
        'AGENT_ACCESS_CONTROL_ENABLED is true but AGENT_ACCESS_ADMINS is ' +
          'empty, and the global-admin roster (system/admin/global-admins.json) ' +
          'could not be read. If it is also empty and no local admins exist, ' +
          'nobody can create or change access rules.',
      );
    } else if (state.localAdminCount === 0) {
      warnings.push(
        'AGENT_ACCESS_CONTROL_ENABLED is true but there are no global admins ' +
          '(AGENT_ACCESS_ADMINS is empty and the global-admin roster has no ' +
          'entries) and no local admins in config.json: existing rules still ' +
          'enforce, but nobody can create or change them. Set ' +
          'AGENT_ACCESS_ADMINS to bootstrap an administrator.',
      );
    } else if (state.localAdminCount === null) {
      warnings.push(
        'AGENT_ACCESS_CONTROL_ENABLED is true but AGENT_ACCESS_ADMINS is ' +
          'empty, and the delegation map could not be read to check for local ' +
          'admins. If none exist, nobody can create or change access rules.',
      );
    }
  }

  return warnings;
}

/**
 * Reads the current configuration and logs any warnings. Never throws: a
 * diagnostic must not be able to break startup. A config read failure is
 * reported as "unknown" (null) rather than "empty", so a transient storage
 * outage cannot produce a false "nobody can author rules" alarm.
 */
export async function logAccessControlStartupWarnings(): Promise<void> {
  try {
    const { env } = await import('@/config/environment');
    const { parseGlobalAdminEmails } =
      await import('@/lib/services/agentAccess/adminAuth');

    const enabled = env.AGENT_ACCESS_CONTROL_ENABLED;
    const envAdminCount = parseGlobalAdminEmails().length;

    // Global admins = env ∪ config roster. The roster service never throws;
    // `rosterUnavailable` after ensureFresh() means the read failed.
    let configAdminCount: number | null = null;
    try {
      const { GlobalAdminRosterService } =
        await import('@/lib/services/admin/GlobalAdminRosterService');
      const roster = GlobalAdminRosterService.getInstance();
      await roster.ensureFresh();
      const snapshot = roster.getSnapshot();
      // No roster blob yet is a definite zero, not an unknown.
      configAdminCount = snapshot.rosterUnavailable
        ? null
        : (snapshot.roster?.admins.length ?? 0);
    } catch {
      configAdminCount = null;
    }
    const globalRosterUnreadable = configAdminCount === null;
    const globalAdminCount = envAdminCount + (configAdminCount ?? 0);

    // Only pay for the blob read when it could change the outcome — that is
    // the single case where the local-admin count is actually consulted.
    let localAdminCount: number | null = null;
    if (enabled && globalAdminCount === 0) {
      try {
        const { createAgentAccessBlobStorage, readConfig } =
          await import('@/lib/services/agentAccess/accessRulesStore');
        const result = await readConfig(createAgentAccessBlobStorage());
        // No config blob yet is a definite zero, not an unknown.
        localAdminCount = result?.config.localAdmins.length ?? 0;
      } catch {
        localAdminCount = null;
      }
    }

    for (const warning of buildAccessControlWarnings({
      enabled,
      globalAdminCount,
      localAdminCount,
      globalRosterUnreadable,
    })) {
      console.warn(`[agent-access] ${warning}`);
    }
  } catch (error) {
    console.warn(
      '[agent-access] Could not check access-control configuration:',
      error,
    );
  }
}
