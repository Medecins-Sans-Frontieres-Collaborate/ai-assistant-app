import {
  M365PlaybookId,
  getPlaybookMeta,
  loadPlaybookPrompt,
} from './playbookRegistry';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useDigestLauncherStore } from '@/client/stores/digestLauncherStore';

/**
 * Starting a PROMPT playbook FILLS THE COMPOSER — it never sends. The
 * prompt is the whole mechanism, so the user sees exactly what is about to
 * be asked, can edit it, and presses send themselves. Nothing about a
 * playbook is hidden from the person running it.
 *
 * A DIGEST playbook opens the Daily digest launcher instead: the digest is
 * a structured job, not a prompt, and the launcher is where the user
 * confirms period and sources before anything is read.
 *
 * Shared by the suggestion chips and the `+` menu entries so both surfaces
 * behave identically.
 */
export async function launchPlaybook(id: M365PlaybookId): Promise<void> {
  const meta = getPlaybookMeta(id);
  if (meta?.kind === 'digest') {
    useDigestLauncherStore
      .getState()
      .open(meta.digestPreset ? { preset: meta.digestPreset } : undefined);
    return;
  }
  const prompt = await loadPlaybookPrompt(id);
  if (prompt === null) return;
  useChatInputStore.getState().setTextFieldValue((previous) => {
    // Never discard what the user already typed — append below it instead.
    const typed = previous.trimEnd();
    return typed.length > 0 ? `${typed}\n\n${prompt}` : prompt;
  });
}

/** @deprecated use launchPlaybook; kept so existing call sites keep compiling. */
export const fillComposerWithPlaybook = launchPlaybook;
