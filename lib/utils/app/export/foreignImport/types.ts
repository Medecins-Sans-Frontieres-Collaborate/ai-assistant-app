/**
 * Shared shapes for importing conversations exported by third-party
 * assistants (ChatGPT, Claude). Adapters normalise a foreign export into
 * `ForeignConversation[]`; `toConversation.ts` turns those into the app's
 * own `Conversation` type. Everything here runs client-side and is fully
 * deterministic — no model calls, no network.
 */

export type ForeignSource = 'chatgpt' | 'claude';

export interface ForeignTurn {
  role: 'user' | 'assistant';
  /** Plain text / markdown of the turn. Never empty after normalisation. */
  text: string;
  /** ISO timestamp when the source recorded one. */
  createdAt?: string;
}

export interface ForeignConversation {
  source: ForeignSource;
  /**
   * Identifier from the source system (ChatGPT conversation id, Claude uuid).
   * Used to derive a deterministic app id so re-importing the same file is
   * detectable in the picker instead of silently duplicating.
   */
  sourceId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  turns: ForeignTurn[];
  /**
   * Count of things the adapter could not carry over: attachments, images,
   * tool calls, code-execution outputs. Surfaced in the picker so the user
   * knows the import is text-only.
   */
  droppedParts: number;
}

export interface ForeignImportDetection {
  source: ForeignSource;
  conversations: ForeignConversation[];
  /**
   * Entries in the file that were recognised as conversations but yielded
   * no importable turns (empty, tool-only, malformed). Reported, not imported.
   */
  skipped: number;
}
