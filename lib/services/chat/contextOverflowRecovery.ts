import { Message } from '@/types/chat';

/**
 * Recovery when the provider rejects the prompt as too long.
 *
 * The context budget (lib/services/contextBudget) trims history by a
 * token ESTIMATE before the request. Estimates run low on dense text, tool
 * results and inlined attachments, so the provider can still answer with
 * `context_length_exceeded`. Rather than surfacing that as a dead end, the
 * service drops the oldest half of the droppable history and tries once
 * more (at most `MAX_OVERFLOW_SHRINKS` times), telling the user through an
 * activity marker. System messages and the most recent `KEEP_RECENT`
 * non-system messages are never dropped: the current question, and the
 * exchange right before it, must reach the model.
 */

export const MAX_OVERFLOW_SHRINKS = 2;
export const KEEP_RECENT = 3;

/**
 * Drop the oldest half of the droppable history. Returns null when there
 * is nothing left to drop (the overflow must then surface to the user).
 */
export function shrinkMessagesForOverflow<T extends { role: string }>(
  messages: readonly T[],
  keepRecent: number = KEEP_RECENT,
): T[] | null {
  const nonSystemIndexes = messages
    .map((message, index) => (message.role === 'system' ? -1 : index))
    .filter((index) => index >= 0);
  const droppable = nonSystemIndexes.slice(
    0,
    Math.max(0, nonSystemIndexes.length - keepRecent),
  );
  if (droppable.length === 0) return null;
  const dropCount = Math.ceil(droppable.length / 2);
  const dropped = new Set(droppable.slice(0, dropCount));
  return messages.filter((_, index) => !dropped.has(index));
}

/** Convenience for the app's own Message type. */
export function shrinkChatHistoryForOverflow(
  messages: readonly Message[],
): Message[] | null {
  return shrinkMessagesForOverflow(messages);
}

/**
 * Tool-loop variant: the current turn (from the last REAL user message
 * onward — its tool_use/tool_result exchange included) is never dropped,
 * because a transcript with a dangling tool call is rejected by every
 * provider. Older history before that anchor loses its oldest half.
 * `isAnchor` tells a real user message from a tool-result carrier (Anthropic
 * puts tool results in role:'user' messages).
 */
export function shrinkTranscriptForOverflow<T extends { role: string }>(
  messages: readonly T[],
  isAnchor: (message: T) => boolean,
): T[] | null {
  let anchor = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isAnchor(messages[index])) {
      anchor = index;
      break;
    }
  }
  if (anchor <= 0) return null;
  const droppable: number[] = [];
  for (let index = 0; index < anchor; index += 1) {
    if (messages[index].role !== 'system') droppable.push(index);
  }
  if (droppable.length === 0) return null;
  const dropped = new Set(droppable.slice(0, Math.ceil(droppable.length / 2)));
  return messages.filter((_, index) => !dropped.has(index));
}
