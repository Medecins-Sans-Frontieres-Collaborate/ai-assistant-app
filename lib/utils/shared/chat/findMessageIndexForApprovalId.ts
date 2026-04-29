import { Conversation } from '@/types/chat';

import { entryToDisplayMessage } from './messageVersioning';

import {
  CONSENT_REQUEST_CLOSE,
  CONSENT_REQUEST_OPEN,
} from '@/lib/streamMarkers';

/**
 * Locates the index of the assistant message whose content embeds a
 * `<<<CONSENT_REQUEST>>>` marker carrying the given `approval_request_id`.
 *
 * Used to attach an outcome (e.g. server-side auto-denial) back to the
 * message that surfaced the prompt. Returns `null` when no message matches.
 *
 * Scoped to the marker payload — substring search is constrained to the
 * region between `CONSENT_REQUEST_OPEN` and `CONSENT_REQUEST_CLOSE` so a
 * stray mention of the id elsewhere in the message body (e.g. an echoed
 * code fence from the model) doesn't produce a false positive.
 */
export function findMessageIndexForApprovalId(
  conv: Conversation,
  approvalRequestId: string,
): number | null {
  if (!approvalRequestId) return null;

  for (let i = 0; i < conv.messages.length; i++) {
    const display = entryToDisplayMessage(conv.messages[i]);
    if (typeof display.content !== 'string') continue;
    const content = display.content;

    let cursor = 0;
    while (true) {
      const open = content.indexOf(CONSENT_REQUEST_OPEN, cursor);
      if (open === -1) break;
      const close = content.indexOf(
        CONSENT_REQUEST_CLOSE,
        open + CONSENT_REQUEST_OPEN.length,
      );
      if (close === -1) break;
      const payload = content.slice(open + CONSENT_REQUEST_OPEN.length, close);
      // Match the structured field, not the raw id, so model-echoed text
      // outside a marker payload can't false-positive into a hit.
      if (payload.includes(`"approval_request_id":"${approvalRequestId}"`)) {
        return i;
      }
      cursor = close + CONSENT_REQUEST_CLOSE.length;
    }
  }
  return null;
}
