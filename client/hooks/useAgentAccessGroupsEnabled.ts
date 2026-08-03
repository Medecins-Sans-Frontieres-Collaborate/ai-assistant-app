import { useFlags } from 'launchdarkly-react-client-sdk';

/**
 * Fourth pass A1: gates the ADMIN group-picker UI (RuleEditor, limits
 * OverrideEditor). Fail-closed with the standard localhost hatch. Server-side
 * group EVALUATION is deliberately not gated — LD is client-only in this app,
 * and rules referencing groups must keep working for users regardless of an
 * admin-facing UI flag (same posture as m365Agents vs its server guard).
 */
export function useAgentAccessGroupsEnabled(): boolean {
  const { agentAccessGroups } = useFlags();
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');
  return agentAccessGroups === true || isLocalhost;
}
