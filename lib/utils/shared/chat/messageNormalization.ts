import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';

/**
 * Content blocks the client expects to see inside `Message.content` arrays.
 * Kept as a strict subset of `Message.content`'s widest array variant so
 * {@link normalizeMessageContent}'s output is assignable to `Message.content`
 * without a widening `as` cast.
 *
 * `thinking` blocks are intentionally excluded: the client stores thinking at
 * `Message.thinking` (top-level), never inside the content array.
 */
type ValidContentBlock =
  | TextMessageContent
  | ImageMessageContent
  | FileMessageContent;

/** Narrowed output type; verifiable-assignable to `Message['content']`. */
type NormalizedContent = string | ValidContentBlock[];

const VALID_BLOCK_TYPES = new Set<ValidContentBlock['type']>([
  'text',
  'image_url',
  'file_url',
]);

const VALID_ROLES = new Set<Message['role']>(['user', 'assistant', 'system']);

function isValidContentBlock(item: unknown): item is ValidContentBlock {
  if (!item || typeof item !== 'object') return false;
  const type = (item as { type?: unknown }).type;
  return (
    typeof type === 'string' &&
    VALID_BLOCK_TYPES.has(type as ValidContentBlock['type'])
  );
}

/**
 * Coerce a message's `content` into a shape the server's Zod schema accepts
 * (`string` or `Array<ContentBlock>`).
 *
 * Older conversations in localStorage can contain messages whose `content`
 * was persisted as `null`, a bare `{type:'text', text:'…'}` object, or some
 * other shape the current `Message` TypeScript union technically permits but
 * that server validation (`InputValidator.MessageContentSchema`) rejects with
 * "Invalid input". Storage-time sanitizers only check `content !== undefined`,
 * so these records survive hydration and poison subsequent chat requests at a
 * seemingly-arbitrary message index.
 *
 * This normalizer is applied at the API-call boundary so the server receives
 * only valid shapes, without touching UI render paths.
 */
export function normalizeMessageContent(content: unknown): NormalizedContent {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content.filter(isValidContentBlock);
  }

  if (isValidContentBlock(content) && content.type === 'text') {
    return content.text;
  }

  return '';
}

/** Detail about what the normalizer changed while processing a message array. */
export interface NormalizationReport {
  /** Messages whose content shape was coerced (e.g., null → "", bare object → string, array items filtered). */
  repairedCount: number;
  /** Messages dropped because they were structurally unsalvageable (e.g., invalid role). */
  droppedCount: number;
}

/** Result of {@link normalizeMessagesForAPI}. */
export interface NormalizationResult {
  messages: Message[];
  report: NormalizationReport;
}

function contentWasCoerced(original: unknown, normalized: unknown): boolean {
  if (typeof original === 'string') return false;
  if (Array.isArray(original) && Array.isArray(normalized)) {
    return original.length !== normalized.length;
  }
  // Any non-string/non-array original that reached a string/array output was coerced.
  return true;
}

/**
 * Apply {@link normalizeMessageContent} to every message in an array, and
 * drop entries that are structurally unsalvageable (e.g., `role` missing or
 * not one of `user`/`assistant`/`system`). Returns a new array plus a report
 * so callers can warn the user / log telemetry when corruption is detected.
 * Input is not mutated.
 */
export function normalizeMessagesForAPI(
  messages: Message[],
): NormalizationResult {
  let repairedCount = 0;
  let droppedCount = 0;

  const out: Message[] = [];
  for (const message of messages) {
    if (
      !message ||
      typeof message !== 'object' ||
      typeof (message as { role?: unknown }).role !== 'string' ||
      !VALID_ROLES.has((message as { role: Message['role'] }).role)
    ) {
      droppedCount++;
      continue;
    }

    const originalContent = (message as Message).content;
    const normalizedContent = normalizeMessageContent(originalContent);

    if (contentWasCoerced(originalContent, normalizedContent)) {
      repairedCount++;
    }

    // `NormalizedContent` is a strict subset of `Message['content']`, so
    // TypeScript accepts this assignment without a widening cast.
    out.push({
      ...(message as Message),
      content: normalizedContent,
    });
  }

  return {
    messages: out,
    report: { repairedCount, droppedCount },
  };
}
