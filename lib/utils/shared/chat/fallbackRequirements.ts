import { flattenEntriesForAPI } from '@/lib/utils/shared/chat/messageVersioning';

import { ConversationEntry } from '@/types/chat';
import { InterpreterMode } from '@/types/interpreterMode';

import type { FallbackRequirements } from '@/config/models';

/**
 * The capabilities a fallback model must (or should) have to rescue a
 * failed turn, derived from what the client knows at send time. Shared by
 * the automatic fallback chain (chatStore) and the manual "Try with
 * <model>" action (Chat.tsx), so the model a user is offered is the model
 * the chain would pick.
 *
 * - Code interpreter: 'require' when the user forced it on (Always) — that
 *   turn is a code/file turn by the user's own statement; 'prefer' in
 *   Intelligent mode, where the turn may or may not need it; nothing when
 *   it is off.
 * - Vision: 'prefer' when the latest user message carries an image. Not
 *   'require': the server upgrades image turns to a vision model anyway
 *   (ModelSelector), so a text-only fallback still sees the images.
 *
 * @param input.interpreterMode - The mode the turn was sent with (after
 *        org-agent and usage-limit gates); undefined = interpreter off.
 * @param input.entries - The conversation's entries as sent.
 * @returns Requirements for getFallbackModel's `opts.requirements`.
 */
export function fallbackRequirementsForTurn(input: {
  interpreterMode?: InterpreterMode;
  entries: ConversationEntry[];
}): FallbackRequirements {
  const requirements: FallbackRequirements = {};
  if (input.interpreterMode === InterpreterMode.ALWAYS) {
    requirements.codeInterpreter = 'require';
  } else if (input.interpreterMode === InterpreterMode.INTELLIGENT) {
    requirements.codeInterpreter = 'prefer';
  }

  const lastUser = flattenEntriesForAPI(input.entries)
    .filter((m) => m.role === 'user')
    .pop();
  const hasImage =
    Array.isArray(lastUser?.content) &&
    lastUser.content.some((part) => part.type === 'image_url');
  if (hasImage) requirements.vision = 'prefer';

  return requirements;
}
