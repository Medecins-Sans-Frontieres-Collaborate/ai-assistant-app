import { useFlags } from 'launchdarkly-react-client-sdk';

/**
 * Capability gates for the Microsoft 365 features.
 *
 * Both flags are fail-closed (`=== true`) — M365 touches tenant mail/file
 * data and must stay dark until consent + comms land. Like
 * `useWorkflowTabsEnabled`, localhost is an escape hatch so the features are
 * testable without a LaunchDarkly setup (with LD unconfigured every flag is
 * `undefined`, which would otherwise hide them everywhere).
 *
 * These gates cover flag state only; every M365 surface additionally
 * requires the per-user connect opt-in (`settingsStore.m365Connected`).
 */
export function useM365Enabled(): {
  filesEnabled: boolean;
  mailEnabled: boolean;
  /** M365 file-backed shareable agents (docs/M365_SECOND_PASS_AGENTS_DESIGN.md). */
  agentsEnabled: boolean;
} {
  const { m365Files, m365Mail, m365Agents } = useFlags();
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');
  return {
    filesEnabled: m365Files === true || isLocalhost,
    mailEnabled: m365Mail === true || isLocalhost,
    agentsEnabled: m365Agents === true || isLocalhost,
  };
}
