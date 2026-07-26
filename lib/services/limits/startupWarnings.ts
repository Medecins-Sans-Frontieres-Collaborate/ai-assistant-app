/**
 * Startup diagnostics for usage limits.
 *
 * Limits have a failure mode access control does not: they can be enabled,
 * authored, and completely inert, because `mode: 'observe'` is the shipping
 * default and there is no visible symptom of it. The whole point of observe
 * mode is that nothing happens — so the only way an operator learns their
 * policy is not enforcing is if we say so at boot.
 *
 * These WARN rather than fail startup: a deployment with limits enabled and
 * no policy authored yet is a perfectly normal intermediate state.
 */
import { parseGlobalAdminEmails } from '@/lib/services/agentAccess/adminAuth';
import { LimitsService } from '@/lib/services/limits/LimitsService';

import { env } from '@/config/environment';

export interface LimitsStartupState {
  enabled: boolean;
  globalAdminCount: number;
  /** null when the policy blob could not be read. */
  mode: 'observe' | 'enforce' | null;
  failMode: 'open' | 'closed' | null;
  /** null when unreadable; 0 when no policy has been authored. */
  configuredLimitCount: number | null;
}

/** Pure so the wording is testable without a storage account. */
export function buildLimitsStartupWarnings(
  state: LimitsStartupState,
): string[] {
  const warnings: string[] = [];

  if (!state.enabled) return warnings;

  if (state.globalAdminCount === 0) {
    warnings.push(
      'LIMITS_ENABLED is true but AGENT_ACCESS_ADMINS is empty: any already- ' +
        'stored policy still applies, but nobody can author or change it. ' +
        'Set AGENT_ACCESS_ADMINS to bootstrap an administrator.',
    );
  }

  if (state.configuredLimitCount === null) {
    warnings.push(
      'LIMITS_ENABLED is true but the limits policy could not be read at ' +
        'startup. Requests FAIL OPEN (everyone is unlimited) until a policy ' +
        'loads. Check the storage account and AZURE_BLOB_STORAGE_* settings.',
    );
  } else if (state.mode === 'observe' && state.configuredLimitCount > 0) {
    warnings.push(
      `Usage limits are in OBSERVE mode with ${state.configuredLimitCount} ` +
        'configured limit(s): nothing is blocked. Would-block decisions are ' +
        'logged as [limits-audit]. Switch to Enforce in the admin UI when the ' +
        'policy looks right.',
    );
  }

  if (state.enabled && state.failMode === 'closed') {
    warnings.push(
      'Usage limits are set to FAIL CLOSED: if the policy or a usage counter ' +
        'becomes unreadable, affected requests are blocked rather than ' +
        'allowed. A storage outage will read to users as a chat outage.',
    );
  }

  return warnings;
}

export async function logLimitsStartupWarnings(): Promise<void> {
  if (!env.LIMITS_ENABLED) return;

  const service = LimitsService.getInstance();
  let mode: LimitsStartupState['mode'] = null;
  let failMode: LimitsStartupState['failMode'] = null;
  let configuredLimitCount: number | null = null;

  try {
    await service.ensureFresh();
    const { policy, policyUnavailable } = service.getSnapshot();
    if (!policyUnavailable) {
      mode = policy?.mode ?? 'observe';
      failMode = policy?.failMode ?? 'open';
      configuredLimitCount =
        (policy?.defaults.length ?? 0) +
        (policy?.overrides.reduce((sum, o) => sum + o.entries.length, 0) ?? 0);
    }
  } catch {
    // Leave everything null: the "could not be read" warning covers it.
  }

  const warnings = buildLimitsStartupWarnings({
    enabled: true,
    globalAdminCount: parseGlobalAdminEmails().length,
    mode,
    failMode,
    configuredLimitCount,
  });

  for (const warning of warnings) {
    console.warn(`[limits] ${warning}`);
  }
  console.log(
    `[limits] enabled mode=${mode ?? '<unreadable>'} failMode=${failMode ?? '<unreadable>'} configured=${configuredLimitCount ?? '<unreadable>'}`,
  );
}
