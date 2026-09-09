/**
 * Shared helpers for the fifth-pass mail READ tools (mailReadTools.ts) and
 * the phishing screen's callers: HTML→text for mail bodies, envelope
 * rendering, $search/$filter query building, and the shared-mailbox gate.
 *
 * DOMAIN BOUNDARY: this module belongs to the mail READ domain only.
 * mailDraftTools.ts and mailCompositeTools.ts must NOT import it — anything
 * a write tool or composite needs lives in shared.ts (cross-domain) or in
 * their own modules. Pure functions + M365ToolInputError throws; no
 * graphApi import (tool modules lazy-import graphApi in their bodies so
 * this graph stays free of next-auth).
 */
import type { M365ToolExecutionContext } from '@/lib/services/m365/tools/executor';
import { M365ToolUserFacingError } from '@/lib/services/m365/tools/executor';
import {
  M365ToolInputError,
  truncateText,
} from '@/lib/services/m365/tools/shared';

import {
  stripHtmlNoise,
  stripHtmlTags,
} from '@/lib/utils/shared/html/stripTags';

/** Envelope fields for list-shaped mail responses — never `body`. */
export const MAIL_ENVELOPE_SELECT =
  '$select=id,conversationId,subject,from,toRecipients,receivedDateTime,' +
  'bodyPreview,hasAttachments,parentFolderId';

/** Full-message fields: body + the headers the phishing screen reads. */
export const MAIL_MESSAGE_SELECT =
  '$select=id,conversationId,subject,from,toRecipients,ccRecipients,replyTo,' +
  'receivedDateTime,body,internetMessageHeaders,hasAttachments,webLink';

/** Ask Graph for plain-text bodies (same as app/api/m365/mail/route.ts). */
export const MAIL_TEXT_BODY_HEADERS = {
  Prefer: 'outlook.body-content-type="text"',
};

export const ENVELOPE_PREVIEW_CHARS = 80;

// Loose Graph shapes — only the fields the mail read tools consume.
export interface GraphMailAddress {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMailEnvelope {
  id?: string;
  conversationId?: string;
  subject?: string;
  from?: GraphMailAddress;
  toRecipients?: GraphMailAddress[];
  receivedDateTime?: string;
  bodyPreview?: string;
  hasAttachments?: boolean;
  parentFolderId?: string;
}

export interface GraphMailFullMessage extends GraphMailEnvelope {
  ccRecipients?: GraphMailAddress[];
  replyTo?: GraphMailAddress[];
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: { name?: string; value?: string }[];
  webLink?: string;
}

export function mailAddress(
  recipient: GraphMailAddress | undefined,
): string | undefined {
  return recipient?.emailAddress?.address?.trim() || undefined;
}

/** 'Ana Silva <ana@x.com>' | address | name | 'Unknown sender'. */
export function formatSender(recipient: GraphMailAddress | undefined): string {
  const name = recipient?.emailAddress?.name?.trim();
  const address = mailAddress(recipient);
  if (name && address && name.toLowerCase() !== address.toLowerCase()) {
    return `${name} <${address}>`;
  }
  return address || name || 'Unknown sender';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Mail-flavored HTML→text: unlike shared.ts stripHtml (which flattens to one
 * line for previews), this preserves paragraph/line structure so a full body
 * stays readable. Used when Graph returns an HTML body despite the
 * text-body Prefer header.
 */
export function mailHtmlToText(html: string): string {
  return stripHtmlTags(
    stripHtmlNoise(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n'),
  )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(
      /&([a-zA-Z]+);/g,
      (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Body text for rendering: converts only when the body is actually HTML. */
export function mailBodyToText(body: {
  contentType?: string;
  content?: string;
}): string {
  const content = body.content ?? '';
  if (
    body.contentType?.toLowerCase() === 'html' ||
    /<\w+[^>]*>/.test(content)
  ) {
    return mailHtmlToText(content);
  }
  return content.trim();
}

/**
 * One compact envelope line: sender, subject, date, preview (≤80 chars),
 * [attachments] marker, and the ids the model needs for follow-up
 * mail_get_message / mail_get_thread calls.
 */
export function renderEnvelopeLine(message: GraphMailEnvelope): string {
  const date = message.receivedDateTime
    ? `${message.receivedDateTime.slice(0, 10)} ${message.receivedDateTime.slice(11, 16)}`
    : 'unknown date';
  const subject = message.subject?.trim() || '(no subject)';
  const preview = truncateText(
    (message.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
    ENVELOPE_PREVIEW_CHARS,
  );
  const toCount = message.toRecipients?.length ?? 0;
  const parts = [
    `- ${date} — ${formatSender(message.from)}${toCount > 1 ? ` (to ${toCount})` : ''}: "${subject}"`,
  ];
  if (preview) parts.push(`— ${preview}`);
  if (message.hasAttachments) parts.push('[attachments]');
  parts.push(
    `(id: ${message.id ?? '?'}${message.conversationId ? `, conversation: ${message.conversationId}` : ''})`,
  );
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Shared-mailbox gate (tier 3)
// ---------------------------------------------------------------------------

/**
 * Resolves the Graph base path for an optional `mailbox` argument. A shared
 * mailbox is honored ONLY when the user configured it (Settings →
 * Connections → Shared mailboxes → ctx.sharedMailboxes), case-insensitively —
 * the model cannot point the tools at arbitrary mailboxes.
 */
export function resolveMailboxBase(
  mailbox: string | undefined,
  ctx: M365ToolExecutionContext,
): { base: string; sharedAddress?: string } {
  if (!mailbox) return { base: '/me' };
  const wanted = mailbox.trim().toLowerCase();
  const configured = ctx.sharedMailboxes.find(
    (address) => address.trim().toLowerCase() === wanted,
  );
  if (!configured) {
    throw new M365ToolInputError(
      `Mailbox ${mailbox} isn't configured as a shared mailbox for this user. ` +
        'The user can add it in Settings → Connections → Shared mailboxes.',
    );
  }
  return {
    base: `/users/${encodeURIComponent(configured.trim())}`,
    sharedAddress: configured.trim(),
  };
}

/**
 * Maps Graph 403/404 on a shared mailbox to the design's user-facing copy —
 * Exchange grants shared-mailbox access; the app cannot. M365Error is
 * detected structurally (name + kind), mirroring the executor, to keep
 * graphApi (and with it next-auth) out of this module graph.
 */
export async function withSharedMailboxAccess<T>(
  sharedAddress: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const err = error as { name?: string; kind?: string };
    if (
      sharedAddress &&
      err?.name === 'M365Error' &&
      (err.kind === 'forbidden' || err.kind === 'not_found')
    ) {
      throw new M365ToolUserFacingError(
        `You don't appear to have access to ${sharedAddress} — access is granted by your Exchange admin.`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// mail_search query building ($search vs $filter)
// ---------------------------------------------------------------------------

export interface ParsedMailQuery {
  freeText: string;
  from?: string;
  hasAttachments?: boolean;
  /** YYYY-MM-DD from a received>= facet. */
  receivedAfter?: string;
}

const RECEIVED_FACET = /^received>=(\d{4}-\d{2}-\d{2})$/i;
const FROM_FACET = /^from:(.+)$/i;
const HAS_ATTACHMENT_FACET = /^hasattachments?:true$/i;

/** Detects the simple facets the catalog documents; the rest is free text. */
export function parseMailQuery(query: string): ParsedMailQuery {
  const parsed: ParsedMailQuery = { freeText: '' };
  const freeTokens: string[] = [];
  for (const token of query.split(/\s+/).filter(Boolean)) {
    const from = FROM_FACET.exec(token);
    const received = RECEIVED_FACET.exec(token);
    if (from) {
      parsed.from = from[1].replace(/["']/g, '');
    } else if (HAS_ATTACHMENT_FACET.test(token)) {
      parsed.hasAttachments = true;
    } else if (received) {
      parsed.receivedAfter = received[1];
    } else {
      freeTokens.push(token);
    }
  }
  parsed.freeText = freeTokens.join(' ');
  return parsed;
}

const EMAIL_SHAPED = /^[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+$/;

/**
 * Builds the query-string portion of the mail_search request (everything
 * after `?`), choosing between $search and $filter.
 *
 * Graph cannot combine $search with $filter, so the choice is:
 *  - Any free text → $search, with detected facets FOLDED INTO the KQL
 *    string ("from:x received>=2026-01-01 budget") — Graph's $search
 *    supports KQL facets inside the quoted term, so nothing is dropped.
 *  - Facets only → $filter (deterministic matching, and it permits
 *    $orderby so results come back newest-first instead of by relevance).
 *    Exception: a non-email `from:` value (a display name) falls back to
 *    $search, because $filter can only equality-match the SMTP address
 *    while KQL `from:` also matches display names.
 * Mirrors app/api/m365/mail/route.ts: when $filter and $orderby are
 * combined, the $orderby property must lead the $filter — hence the
 * receivedDateTime guard clause.
 */
export function buildMailSearchQuery(
  parsed: ParsedMailQuery,
  top: number,
): string {
  const useSearch =
    parsed.freeText.length > 0 ||
    (parsed.from ? !EMAIL_SHAPED.test(parsed.from) : false);

  if (useSearch) {
    const kqlParts: string[] = [];
    if (parsed.from) kqlParts.push(`from:${parsed.from}`);
    if (parsed.hasAttachments) kqlParts.push('hasAttachments:true');
    if (parsed.receivedAfter)
      kqlParts.push(`received>=${parsed.receivedAfter}`);
    if (parsed.freeText) kqlParts.push(parsed.freeText);
    // Quote-stripped, then quoted as one $search term (route pattern).
    const term = kqlParts.join(' ').replace(/"/g, '');
    return `$search="${encodeURIComponent(term)}"&$top=${top}&${MAIL_ENVELOPE_SELECT}`;
  }

  const clauses = [
    parsed.receivedAfter
      ? `receivedDateTime ge ${parsed.receivedAfter}T00:00:00Z`
      : 'receivedDateTime ge 1900-01-01T00:00:00Z',
  ];
  if (parsed.from) {
    // escapeODataLiteral semantics (single quotes doubled) applied inline —
    // the value already passed the email-shape check above.
    clauses.push(
      `from/emailAddress/address eq '${parsed.from.replace(/'/g, "''")}'`,
    );
  }
  if (parsed.hasAttachments) clauses.push('hasAttachments eq true');
  return (
    `$filter=${encodeURIComponent(clauses.join(' and '))}` +
    `&$orderby=receivedDateTime desc&$top=${top}&${MAIL_ENVELOPE_SELECT}`
  );
}

// ---------------------------------------------------------------------------
// Body caps
// ---------------------------------------------------------------------------

/** mail_get_message body cap — sits well below the loop's 30k mapper bound. */
export const MESSAGE_BODY_CAP = 8000;
/**
 * Per-body cap inside mail_get_thread: up to 5 full bodies plus envelopes
 * must stay under the loop's 30k output bound, so each body gets less room
 * than a single mail_get_message.
 */
export const THREAD_BODY_CAP = 4000;

/** Hard cap with an explicit, counted truncation marker (never silent). */
export function capBody(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const remainder = text.length - cap;
  return `${text.slice(0, cap)}…[truncated — ${remainder} more characters]`;
}
