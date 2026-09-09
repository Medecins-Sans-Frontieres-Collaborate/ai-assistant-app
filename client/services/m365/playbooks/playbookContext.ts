import type { ConversationEntry, FilePreview } from '@/types/chat';
import { isAssistantMessageGroup } from '@/types/chat';

/**
 * Client-side precondition inputs for the M365 playbooks. Everything here is
 * derived from state the composer already has in memory — no network calls,
 * no Graph round-trips: preconditions run on every render, so a chip that
 * costs a request would be worse than no chip at all.
 */
export interface M365PlaybookContext {
  /**
   * A meeting/audio transcript is available to work from: either a
   * `[Transcript: …]` message in the conversation (the marker written by the
   * transcription pipeline and by the pass-3 meeting import) or a
   * transcript-ish file staged in the composer.
   */
  hasTranscriptAttachment: boolean;
  /** Local clock is in the 05:00–11:59 band. */
  isMorning: boolean;
  /** The per-user Microsoft 365 opt-in from Settings → Connections. */
  m365Connected: boolean;
}

/**
 * How far back to look for a transcript. A transcript from 50 messages ago is
 * no longer what the user is working on, and scanning a long conversation on
 * every keystroke is wasteful.
 */
const TRANSCRIPT_LOOKBACK_MESSAGES = 20;

/** The marker every transcript message starts with (see TranscriptViewer). */
const TRANSCRIPT_MARKER = '[Transcript:';

/**
 * Pull the plain text out of a message content union, or null when the
 * content is structured (image/file/extraction payloads never carry the
 * transcript marker).
 */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (content === null || typeof content !== 'object') return null;
  const candidate = content as { type?: unknown; text?: unknown };
  return candidate.type === 'text' && typeof candidate.text === 'string'
    ? candidate.text
    : null;
}

function entryHasTranscriptMarker(entry: ConversationEntry): boolean {
  const contents = isAssistantMessageGroup(entry)
    ? entry.versions.map((version) => version.content)
    : [entry.content];
  return contents.some((content) =>
    (contentText(content) ?? '').startsWith(TRANSCRIPT_MARKER),
  );
}

/** True when the recent conversation contains a transcript message. */
export function hasTranscriptMessage(
  messages: readonly ConversationEntry[] | undefined,
): boolean {
  if (!messages || messages.length === 0) return false;
  return messages
    .slice(-TRANSCRIPT_LOOKBACK_MESSAGES)
    .some(entryHasTranscriptMarker);
}

/**
 * True when a staged upload looks like a transcript. Deliberately a
 * name/extension heuristic: the composer has no parsed content to inspect,
 * and a false positive costs at most one dismissible chip.
 */
export function hasTranscriptFilePreview(
  previews: readonly FilePreview[] | undefined,
): boolean {
  if (!previews || previews.length === 0) return false;
  return previews.some((preview) => {
    const name = preview.name.toLowerCase();
    return (
      name.endsWith('.vtt') ||
      name.endsWith('.srt') ||
      name.includes('transcript')
    );
  });
}

/** Local-clock morning band, inclusive of 05:00 and 11:59. */
export function isMorningHour(now: Date): boolean {
  const hour = now.getHours();
  return hour >= 5 && hour <= 11;
}

export function buildPlaybookContext(input: {
  messages?: readonly ConversationEntry[];
  filePreviews?: readonly FilePreview[];
  m365Connected: boolean;
  now?: Date;
}): M365PlaybookContext {
  return {
    hasTranscriptAttachment:
      hasTranscriptMessage(input.messages) ||
      hasTranscriptFilePreview(input.filePreviews),
    isMorning: isMorningHour(input.now ?? new Date()),
    m365Connected: input.m365Connected,
  };
}
