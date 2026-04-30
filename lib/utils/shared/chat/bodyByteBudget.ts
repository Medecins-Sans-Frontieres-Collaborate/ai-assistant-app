import { VALIDATION_LIMITS } from '@/lib/utils/app/const';

import { ImageMessageContent, Message, TextMessageContent } from '@/types/chat';

/**
 * Placeholder text inserted in place of a stripped image. Visible to the model
 * so it knows an image used to be here without re-paying the bytes.
 */
const STRIPPED_IMAGE_PLACEHOLDER =
  '[image from earlier turn not resent — context trimmed to fit body size limit]';

export interface TrimReport {
  /** JSON.stringify length of the body before trimming. */
  originalBytes: number;
  /** JSON.stringify length of the body after trimming. */
  finalBytes: number;
  /** Image blocks replaced with text placeholders. */
  imagesStripped: number;
  /** Messages dropped entirely (after image-stripping was insufficient). */
  messagesDropped: number;
  /** True when even after both phases the body still exceeds the budget. */
  exceededBudget: boolean;
}

interface TrimmableBody {
  messages: Message[];
  [key: string]: unknown;
}

function bodySize(body: unknown): number {
  // Match the server's measure exactly (InputValidator.validateRequestSize)
  // so we don't drift from the gate we're trying to stay under.
  return JSON.stringify(body).length;
}

function isImageBlock(item: unknown): item is ImageMessageContent {
  return (
    !!item &&
    typeof item === 'object' &&
    'type' in (item as object) &&
    (item as { type: unknown }).type === 'image_url'
  );
}

function lastIndexByRole(messages: Message[], role: Message['role']): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return i;
  }
  return -1;
}

function stripImagesFromMessage(msg: Message): {
  message: Message;
  stripped: number;
} {
  if (!Array.isArray(msg.content)) {
    return { message: msg, stripped: 0 };
  }
  let stripped = 0;
  const kept: Array<TextMessageContent | ImageMessageContent | object> = [];
  for (const item of msg.content) {
    if (isImageBlock(item)) {
      stripped++;
      continue;
    }
    kept.push(item);
  }
  if (stripped === 0) return { message: msg, stripped: 0 };

  const placeholder: TextMessageContent = {
    type: 'text',
    text: STRIPPED_IMAGE_PLACEHOLDER,
  };
  return {
    message: {
      ...msg,
      content: [...kept, placeholder] as Message['content'],
    },
    stripped,
  };
}

/**
 * Trim a chat request body to fit within a JSON-stringified byte budget.
 *
 * Phase 1 — strip `image_url` blocks from older turns (every message at an
 * index strictly less than the latest user message). Replaces each removed
 * image with a short text placeholder so the model still sees a marker.
 *
 * Phase 2 — drop oldest non-anchor messages. Anchors that are always
 * preserved: index 0 (initial context — same invariant as
 * `windowMessagesForAPI`) and the latest user message (the current send).
 *
 * If both phases together can't get the body under budget — typically because
 * the latest user turn alone is oversized — the function returns the
 * partially-trimmed body with `report.exceededBudget = true`. The server's
 * existing 10 MB rejection is the right error in that case, since the user
 * just attached more than fits in a single turn.
 *
 * The body is returned as a shallow copy with `messages` replaced; the input
 * is not mutated.
 */
export function trimBodyToByteBudget<T extends TrimmableBody>(
  body: T,
  budgetBytes: number = VALIDATION_LIMITS.CLIENT_BODY_TRIM_BUDGET_BYTES,
): { body: T; report: TrimReport } {
  const originalBytes = bodySize(body);

  if (originalBytes <= budgetBytes) {
    return {
      body,
      report: {
        originalBytes,
        finalBytes: originalBytes,
        imagesStripped: 0,
        messagesDropped: 0,
        exceededBudget: false,
      },
    };
  }

  let messages = [...body.messages];
  let imagesStripped = 0;
  let messagesDropped = 0;
  let lastUserIdx = lastIndexByRole(messages, 'user');

  // Phase 1: strip images from older turns.
  if (lastUserIdx > 0) {
    for (let i = 0; i < lastUserIdx; i++) {
      const result = stripImagesFromMessage(messages[i]);
      if (result.stripped === 0) continue;
      messages[i] = result.message;
      imagesStripped += result.stripped;
      if (bodySize({ ...body, messages }) <= budgetBytes) break;
    }
  }

  // Phase 2: drop oldest non-anchor messages while still over budget.
  // Anchors: messages[0] and the latest user message.
  while (messages.length > 2 && bodySize({ ...body, messages }) > budgetBytes) {
    // Recompute the anchor index — it shifts left as we drop earlier messages.
    lastUserIdx = lastIndexByRole(messages, 'user');
    if (lastUserIdx <= 1) break; // nothing left between the two anchors

    // Drop the message at index 1 (oldest non-anchor).
    messages.splice(1, 1);
    messagesDropped++;
  }

  // If phase 2 dropped messages, the message now at index 1 may be an
  // assistant whose paired user turn was just removed. Drop it too so the
  // model isn't seeing an orphaned reply (mirrors windowMessagesForAPI).
  if (
    messagesDropped > 0 &&
    messages.length >= 2 &&
    messages[1]?.role === 'assistant'
  ) {
    messages.splice(1, 1);
    messagesDropped++;
  }

  const trimmedBody = { ...body, messages };
  const finalBytes = bodySize(trimmedBody);

  return {
    body: trimmedBody,
    report: {
      originalBytes,
      finalBytes,
      imagesStripped,
      messagesDropped,
      exceededBudget: finalBytes > budgetBytes,
    },
  };
}

export const __testing__ = { STRIPPED_IMAGE_PLACEHOLDER };
