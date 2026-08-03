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
  /** §1 third pass: translate from/to OneDrive (docs/M365_THIRD_PASS_FEATURES_DESIGN.md). */
  translationEnabled: boolean;
  /** §3 third pass: attach audio/video from OneDrive for transcription. */
  transcriptionEnabled: boolean;
  /** §2 third pass: document-workflow bindings with two-way OneDrive sync. */
  docSyncEnabled: boolean;
  /** §4 third pass: meeting transcript/recording import + To Do outputs. */
  meetingsEnabled: boolean;
  /** Fourth pass B: the builtin Microsoft 365 toolset in the tool loop. */
  toolsEnabled: boolean;
  /** Sixth pass: curated cross-service playbooks (chips + menu entries). */
  playbooksEnabled: boolean;
  /** Encrypted-backup storage in the user's OneDrive app folder. */
  backupEnabled: boolean;
} {
  const {
    m365Files,
    m365Mail,
    m365Agents,
    m365Translation,
    m365Transcription,
    m365DocSync,
    m365Meetings,
    m365Tools,
    m365Playbooks,
    m365Backup,
  } = useFlags();
  const isLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');
  return {
    filesEnabled: m365Files === true || isLocalhost,
    mailEnabled: m365Mail === true || isLocalhost,
    agentsEnabled: m365Agents === true || isLocalhost,
    translationEnabled: m365Translation === true || isLocalhost,
    transcriptionEnabled: m365Transcription === true || isLocalhost,
    docSyncEnabled: m365DocSync === true || isLocalhost,
    meetingsEnabled: m365Meetings === true || isLocalhost,
    toolsEnabled: m365Tools === true || isLocalhost,
    playbooksEnabled: m365Playbooks === true || isLocalhost,
    backupEnabled: m365Backup === true || isLocalhost,
  };
}
