import { stripThinking } from '@/lib/utils/app/stream/thinking';
import { flattenEntriesForAPI } from '@/lib/utils/shared/chat/messageVersioning';
import { rewriteSandboxLinks } from '@/lib/utils/shared/chat/sandboxLinks';

import { Conversation, Message } from '@/types/chat';

/**
 * Content preparation for sharing a conversation (or a slice of it) as a
 * readable document in OneDrive. Pure functions — the modal composes them
 * with the existing export/save pipeline (`buildBlob` + `saveToOneDrive`).
 *
 * Sharing is deliberate disclosure, so the renderer strips everything that
 * is app plumbing rather than content: stream-event markers, the terminal
 * metadata block, thinking traces, and sandbox links. What the recipient
 * reads is what the sharer saw on screen.
 */

export interface ShareFilterOptions {
  /** Keep only assistant messages (summaries/answers without the back-and-forth). */
  assistantOnly?: boolean;
  /** Keep only the last N messages (applied AFTER assistantOnly). */
  lastCount?: number;
}

/**
 * The marker vocabulary is enumerated rather than wildcarded (`<<<[A-Z_]+`)
 * so legitimate content that merely resembles a marker — a bash heredoc
 * (`<<<EOF`) in a code block, say — is never stripped.
 */
const MARKER_KINDS =
  'AGENT_ACTIVITY|CONSENT_REQUEST|CONSENT_OUTCOME|TOOL_CALL_RECORD|WORKFLOW_EVENT|SEARCH_INTERIM';

/** Complete stream-event marker blocks, with surrounding gaps. */
const MARKER_BLOCK_RE = new RegExp(
  `\\n*<<<(?:${MARKER_KINDS})>>>[\\s\\S]*?<<<END_(?:${MARKER_KINDS})>>>\\n*`,
  'g',
);

/** The terminal metadata block (citations/usage) — never part of the text. */
const METADATA_BLOCK_RE =
  /\n*<<<METADATA_START>>>[\s\S]*?(<<<METADATA_END>>>|$)/g;

/** A partially-streamed KNOWN marker with no close (aborted stream tail). */
const PARTIAL_MARKER_RE = new RegExp(
  `\\n*<<<(?:${MARKER_KINDS}|METADATA_START)[\\s\\S]*$`,
);

function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (
    part &&
    typeof part === 'object' &&
    (part as { type?: string }).type === 'text'
  ) {
    return (part as { text?: string }).text ?? '';
  }
  return '';
}

function contentToText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  // Structured contents keep only typed text; file/image/extraction parts
  // are per-user app resources a recipient cannot access anyway (see the
  // attachments caveat in the share dialog copy).
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join('\n\n');
  }
  return partText(content);
}

/** Strips app plumbing from one message's text. */
export function cleanShareText(content: Message['content']): string {
  let text = contentToText(content);
  text = text.replace(METADATA_BLOCK_RE, '');
  text = stripThinking(text);
  text = text.replace(MARKER_BLOCK_RE, '\n\n');
  // An unterminated KNOWN marker means the tail is plumbing, not prose.
  text = text.replace(PARTIAL_MARKER_RE, '');
  return rewriteSandboxLinks(text).trim();
}

/**
 * The messages a share covers: active versions only (what the sharer sees),
 * then the filters, then a final drop of messages that clean to nothing.
 */
export function collectShareMessages(
  conversation: Conversation,
  options: ShareFilterOptions = {},
): Message[] {
  let messages: Message[] = flattenEntriesForAPI(conversation.messages ?? []);
  if (options.assistantOnly) {
    messages = messages.filter((message) => message.role === 'assistant');
  }
  if (
    options.lastCount !== undefined &&
    Number.isFinite(options.lastCount) &&
    options.lastCount > 0
  ) {
    messages = messages.slice(-Math.floor(options.lastCount));
  }
  return messages.filter((message) => cleanShareText(message.content) !== '');
}

/**
 * Renders the share as a single markdown document. Role headings keep the
 * document readable in Word/browser previews; a lone assistant message gets
 * no heading at all (the common "share this answer" case reads as prose).
 */
export function renderShareMarkdown(
  title: string,
  messages: Message[],
  labels: { user: string; assistant: string },
): string {
  const parts: string[] = [`# ${title.trim() || 'Conversation'}`];
  const single = messages.length === 1 && messages[0].role === 'assistant';
  for (const message of messages) {
    const text = cleanShareText(message.content);
    if (!text) continue;
    if (!single) {
      parts.push(
        `## ${message.role === 'assistant' ? labels.assistant : labels.user}`,
      );
    }
    parts.push(text);
  }
  return parts.join('\n\n');
}
