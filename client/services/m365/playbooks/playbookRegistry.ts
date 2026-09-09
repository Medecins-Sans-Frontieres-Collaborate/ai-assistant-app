import type { M365PlaybookContext } from './playbookContext';

/**
 * Registry for the sixth-pass Microsoft 365 playbooks — curated cross-service
 * chains surfaced as suggestion chips and menu entries
 * (docs/M365_SIXTH_PASS_CROSS_SERVICE_WORKFLOWS.md).
 *
 * A playbook is DATA, not code: an id, i18n keys, a cheap client-side
 * precondition, and a prompt body. This module deliberately holds only the
 * light metadata — the prompt bodies are several kilobytes of prose each and
 * are lazy-loaded through `loadPlaybookPrompt`, mirroring the
 * components/Workflows registryMeta.ts ↔ registry.tsx split (menus must be
 * able to list playbooks without pulling the prompts into the chat bundle).
 *
 * Playbooks never gate emergent chains: the model can already compose the
 * same tools when the user asks in their own words. These are starting
 * points, nothing more.
 */

export type M365PlaybookId = 'meetingFollowThrough' | 'morningTriage';

export interface M365PlaybookMeta {
  id: M365PlaybookId;
  /** Key under the `m365.playbooks.*` namespace in messages/en.json. */
  titleKey: `${M365PlaybookId}.title`;
  descriptionKey: `${M365PlaybookId}.description`;
  /**
   * Pure, synchronous, and cheap — it runs on every composer render, so it
   * may only read the context object (never fetch, never touch Graph).
   */
  precondition: (context: M365PlaybookContext) => boolean;
}

export const M365_PLAYBOOKS: readonly M365PlaybookMeta[] = [
  {
    id: 'meetingFollowThrough',
    titleKey: 'meetingFollowThrough.title',
    descriptionKey: 'meetingFollowThrough.description',
    // Transcript-anchored: without a transcript in the conversation the
    // chain has nothing to read, so the chip would be an empty promise.
    precondition: (context) =>
      context.hasTranscriptAttachment && context.m365Connected,
  },
  {
    id: 'morningTriage',
    titleKey: 'morningTriage.title',
    descriptionKey: 'morningTriage.description',
    // Tool-only: the briefing is worth offering when the day starts, not at
    // 4pm when the user has already read their mail.
    precondition: (context) => context.isMorning && context.m365Connected,
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
 * Lazy prompt loader. Each body lives in its own module so a chip render
 * costs nothing until the user actually picks a playbook.
 */
export async function loadPlaybookPrompt(id: M365PlaybookId): Promise<string> {
  switch (id) {
    case 'meetingFollowThrough': {
      const loaded = await import('./prompts/meetingFollowThrough');
      return loaded.MEETING_FOLLOW_THROUGH_PROMPT;
    }
    case 'morningTriage': {
      const loaded = await import('./prompts/morningTriage');
      return loaded.MORNING_TRIAGE_PROMPT;
    }
  }
}
