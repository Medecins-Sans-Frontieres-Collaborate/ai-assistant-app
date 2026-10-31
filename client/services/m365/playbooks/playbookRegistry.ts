import type { DigestPeriodPreset } from '@/lib/services/m365/digest/digestWindow';

import type { M365PlaybookContext } from './playbookContext';

/**
 * Registry for the Microsoft 365 playbooks — curated starting points
 * surfaced as suggestion chips and menu entries
 * (docs/M365_SIXTH_PASS_CROSS_SERVICE_WORKFLOWS.md).
 *
 * Two kinds:
 *  - `prompt`: DATA, not code — an id, i18n keys, a cheap client-side
 *    precondition, and a lazily loaded prompt body that fills the composer.
 *  - `digest`: opens the Daily digest launcher with a period preset
 *    (docs/M365_DAILY_DIGEST.md). "Morning triage" is this kind since the
 *    digest replaced its three-tool prompt: it opens on "since the last
 *    workday", so a Monday morning covers Friday and the weekend.
 *
 * Light metadata only — prompt bodies are lazy-loaded through
 * `loadPlaybookPrompt`, mirroring the components/Workflows registryMeta.ts
 * ↔ registry.tsx split. Playbooks never gate emergent chains.
 */

export type M365PlaybookId =
  | 'meetingFollowThrough'
  | 'morningTriage'
  | 'dailyDigest';

export type M365PlaybookKind = 'prompt' | 'digest';

export interface M365PlaybookMeta {
  id: M365PlaybookId;
  kind: M365PlaybookKind;
  /** Key under the `m365.playbooks.*` namespace in messages/en.json. */
  titleKey: `${M365PlaybookId}.title`;
  descriptionKey: `${M365PlaybookId}.description`;
  /**
   * Pure, synchronous, and cheap — it runs on every composer render, so it
   * may only read the context object (never fetch, never touch Graph).
   * Governs the suggestion CHIP only; menu entries list every playbook.
   */
  precondition: (context: M365PlaybookContext) => boolean;
  /** `digest` kind: the preset the launcher opens with (null = the user's default). */
  digestPreset?: DigestPeriodPreset | null;
}

export const M365_PLAYBOOKS: readonly M365PlaybookMeta[] = [
  {
    id: 'meetingFollowThrough',
    kind: 'prompt',
    titleKey: 'meetingFollowThrough.title',
    descriptionKey: 'meetingFollowThrough.description',
    // Transcript-anchored: without a transcript in the conversation the
    // chain has nothing to read, so the chip would be an empty promise.
    precondition: (context) =>
      context.hasTranscriptAttachment && context.m365Connected,
  },
  {
    id: 'morningTriage',
    kind: 'digest',
    titleKey: 'morningTriage.title',
    descriptionKey: 'morningTriage.description',
    // Worth offering when the day starts, not at 4pm.
    precondition: (context) => context.isMorning && context.m365Connected,
    digestPreset: 'lastWorkday',
  },
  {
    id: 'dailyDigest',
    kind: 'digest',
    titleKey: 'dailyDigest.title',
    descriptionKey: 'dailyDigest.description',
    // Menu only: a standing "run a digest" chip would be furniture.
    precondition: () => false,
    digestPreset: null,
  },
] as const;

/** Metadata lookup for the menu/chips; returns undefined for unknown ids. */
export function getPlaybookMeta(
  id: M365PlaybookId,
): M365PlaybookMeta | undefined {
  return M365_PLAYBOOKS.find((playbook) => playbook.id === id);
}

/** The playbooks whose precondition currently holds, in registry order. */
export function getEligiblePlaybooks(
  context: M365PlaybookContext,
): M365PlaybookMeta[] {
  return M365_PLAYBOOKS.filter((playbook) => playbook.precondition(context));
}

/**
 * Lazy prompt loader for `prompt` playbooks. Each body lives in its own
 * module so a chip render costs nothing until the user picks a playbook.
 * Digest playbooks have no prompt and resolve to null.
 */
export async function loadPlaybookPrompt(
  id: M365PlaybookId,
): Promise<string | null> {
  switch (id) {
    case 'meetingFollowThrough': {
      const loaded = await import('./prompts/meetingFollowThrough');
      return loaded.MEETING_FOLLOW_THROUGH_PROMPT;
    }
    default:
      return null;
  }
}
