/**
 * Rules and document builders for turning an oversized paste into an
 * attachment.
 *
 * The parallel to a pasted link is deliberate (see `client/services/url/
 * urlAttachment`): in both cases the clipboard holds a *document* rather than
 * a sentence, and the useful thing to do is attach it and leave the composer
 * free for the actual question. The difference is that there is nothing to
 * fetch — the text is already in hand.
 *
 * Pure string/number helpers so the thresholds and wording can be unit-tested
 * without a DOM, with all copy passed in by the caller that owns the
 * translations.
 */

/**
 * Floor for the configurable threshold. Below roughly this size a paste is
 * plausibly something the user means to edit in place (an address, a snippet,
 * a quoted paragraph), and attaching it would be an obstacle rather than a
 * convenience.
 */
export const PASTE_ATTACHMENT_MIN_CHARS = 500;

/** Guards against a hand-edited value that would attach essentially never. */
export const PASTE_ATTACHMENT_MAX_CHARS = 100_000;

/**
 * Default threshold. Around 2000 characters a paste has stopped being
 * something you can read inside a two-row composer, which is the point at
 * which attaching starts to help rather than surprise.
 */
export const DEFAULT_PASTE_ATTACHMENT_CHARS = 2000;

/**
 * Normalizes the stored threshold. `0` is meaningful — it disables the
 * behavior — so it survives clamping; every other value is pulled into
 * [MIN, MAX]. Anything non-finite falls back to the default rather than
 * disabling silently, since a corrupt value should not quietly turn a
 * feature off.
 */
export function clampPasteAttachmentChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PASTE_ATTACHMENT_CHARS;
  }
  if (value <= 0) return 0;
  return Math.min(
    PASTE_ATTACHMENT_MAX_CHARS,
    Math.max(PASTE_ATTACHMENT_MIN_CHARS, Math.round(value)),
  );
}

/**
 * Whether this clipboard text should become an attachment.
 *
 * Measured on the trimmed text so trailing whitespace from a sloppy selection
 * can't push a borderline paste over the line.
 */
export function shouldAttachPastedText(
  text: string,
  threshold: number,
): boolean {
  const limit = clampPasteAttachmentChars(threshold);
  if (limit === 0) return false;
  return text.trim().length > limit;
}

export interface PastedTextDocumentCopy {
  heading: string;
  pastedLabel: string;
}

/**
 * Wraps the pasted text in the same shape as a fetched page: a heading, a
 * timestamp, then the content after a rule. Keeping the two formats aligned
 * means the model sees attachments of one kind, however they arrived.
 */
export function buildPastedTextDocument(
  text: string,
  copy: PastedTextDocumentCopy,
  now: Date = new Date(),
): string {
  return `# ${copy.heading}\n\n${copy.pastedLabel}: ${now.toISOString()}\n\n---\n\n${text.trim()}\n`;
}

/**
 * Short deterministic suffix, matching `urlAttachment.shortHash`. The upload
 * pipeline keys previews and progress by filename, so two pastes must not
 * collide — and the same text pasted twice should produce the same name so it
 * reads as a repeat rather than a second unrelated file.
 */
export function pastedTextHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * A readable, filesystem-safe title built from the paste's opening words, so
 * a tile or chip says something about the content instead of just "pasted
 * text". Shared by the chat filename and the workflow chip label so the same
 * paste reads the same way on both surfaces.
 */
export function pastedTextTitle(text: string, fallback: string): string {
  const firstLine =
    text
      .trim()
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length > 0) ?? '';

  const base = firstLine
    .replace(/[\\/:*?"<>|#]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[-\s]+$/, '');

  return base || fallback;
}

/** Collision-resistant, deterministic filename for an attached paste. */
export function pastedTextFileName(text: string, fallback: string): string {
  return `${pastedTextTitle(text, fallback)}-${pastedTextHash(text)}.md`;
}
