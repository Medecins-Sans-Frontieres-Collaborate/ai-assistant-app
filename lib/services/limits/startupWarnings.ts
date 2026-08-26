/**
 * Startup diagnostics for usage limits.
 *
 * Limits have a failure mode access control does not: they can be authored
 * and completely inert, because `mode: 'observe'` is the shipping default and
 * there is no visible symptom of it. The whole point of observe mode is that
 * nothing happens — so the only way an operator learns their policy is not
 * enforcing is if we say so at boot.
 *
 * There is no server-side enable flag any more (the rollout gate is the
 * client-side `usageLimits` LaunchDarkly flag), so this runs on every
 * deployment. To keep deployments that never touched limits quiet, the
 * roster/observe warnings fire only when a policy has actually been authored;
 * the unreadable-policy warning always fires because it may be masking one.
 *
 * These WARN rather than fail startup: a deployment with no policy authored
 * yet is a perfectly normal state.
 */
import { parseGlobalAdminEmails } from '@/lib/services/agentAccess/adminAuth';
import { LimitsService } from '@/lib/services/limits/LimitsService';

export interface LimitsStartupState {
  globalAdminCount: number;
  /** True when a policy document exists in storage. */
  policyExists: boolean;
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

  if (state.policyExists && state.globalAdminCount === 0) {
    warnings.push(
      'A usage-limits policy is stored but AGENT_ACCESS_ADMINS is empty: the ' +
        'policy still applies, but nobody can author or change it. Set ' +
        'AGENT_ACCESS_ADMINS to bootstrap an administrator.',
    );
  }

  if (state.configuredLimitCount === null) {
    warnings.push(
      'The usage-limits policy could not be read at startup. Requests FAIL ' +
        'OPEN (everyone is unlimited) until a policy loads. Check the ' +
        'storage account and AZURE_BLOB_STORAGE_* settings.',
    );
  } else if (state.mode === 'observe' && state.configuredLimitCount > 0) {
    warnings.push(
      `Usage limits are in OBSERVE mode with ${state.configuredLimitCount} ` +
        'configured limit(s): nothing is blocked. Would-block decisions are ' +
        'logged as [limits-audit]. Switch to Enforce in the admin UI when the ' +
        'policy looks right.',
    );
  }

  if (state.failMode === 'closed') {
    warnings.push(
      'Usage limits are set to FAIL CLOSED: if the policy or a usage counter ' +
        'becomes unreadable, affected requests are blocked rather than ' +
        'allowed. A storage outage will read to users as a chat outage.',
    );
  }

  return warnings;
}

export async function logLimitsStartupWarnings(): Promise<void> {
  const service = LimitsService.getInstance();
  let policyExists = false;
  let mode: LimitsStartupState['mode'] = null;
  let failMode: LimitsStartupState['failMode'] = null;
  let configuredLimitCount: number | null = null;

  try {
    await service.ensureFresh();
    const { policy, policyUnavailable } = service.getSnapshot();
    if (!policyUnavailable) {
      policyExists = policy !== null;
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
    globalAdminCount: parseGlobalAdminEmails().length,
    policyExists,
    mode,
    failMode,
    configuredLimitCount,
  });

  for (const warning of warnings) {
    console.warn(`[limits] ${warning}`);
  }
  console.log(
    `[limits] mode=${mode ?? '<unreadable>'} failMode=${failMode ?? '<unreadable>'} configured=${configuredLimitCount ?? '<unreadable>'}`,
  );
}
