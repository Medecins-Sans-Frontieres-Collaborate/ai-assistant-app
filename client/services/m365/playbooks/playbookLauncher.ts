import { M365PlaybookId, loadPlaybookPrompt } from './playbookRegistry';

import { useChatInputStore } from '@/client/stores/chatInputStore';

/**
 * Starting a playbook FILLS THE COMPOSER — it never sends. The prompt is the
 * whole mechanism, so the user sees exactly what is about to be asked, can
 * edit it (drop a stage, add "and cc Ana"), and presses send themselves.
 * Nothing about a playbook is hidden from the person running it.
 *
 * Shared by the suggestion chips and the `+` menu entries so both surfaces
 * behave identically.
 */
export async function fillComposerWithPlaybook(
  id: M365PlaybookId,
): Promise<void> {
  const prompt = await loadPlaybookPrompt(id);
  useChatInputStore.getState().setTextFieldValue((previous) => {
    // Never discard what the user already typed — append below it instead.
    const typed = previous.trimEnd();
    return typed.length > 0 ? `${typed}\n\n${prompt}` : prompt;
  });
}
