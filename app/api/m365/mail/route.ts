/**
 * Outlook mail listing + import for the M365 mail-import flow.
 *
 * GET /api/m365/mail                      → recent inbox envelopes
 * GET /api/m365/mail?q=…                  → search envelopes
 * GET /api/m365/mail?filters=…            → inbox filtered by chips (browse only)
 * GET /api/m365/mail?pageToken=…          → next page of a previous listing
 * GET /api/m365/mail?messageId=…          → one message rendered as markdown
 * GET /api/m365/mail?conversationId=…     → the whole thread as markdown
 *
 * Read-only (`Mail.Read`). Bodies are requested as plain text via the
 * `Prefer: outlook.body-content-type="text"` header, so no HTML handling
 * happens anywhere. Attachment contents are never fetched — the rendered
 * document lists their names only.
 *
 * Filters accept `unread` and `hasAttachments` only ('flagged' is deferred:
 * flag/flagStatus $filter 400s on some tenants). In search mode ($search)
 * `filters` is silently ignored — Graph rejects $search combined with
 * $filter or $orderby — and the client filters loaded results locally.
 *
 * `pageToken` is an opaque wrapper around Graph's @odata.nextLink, validated
 * via graphPageToken before replay (SSRF guard: graphFetch attaches a bearer
 * token to any absolute URL). A nextLink already encodes the original query,
 * so q/filters are ignored when pageToken is present.
 *
 * Markdown label copy arrives from the client (`fromLabel` etc. params are
 * NOT accepted — labels are fixed English here and the client owns display
 * localization of envelopes; the imported document is model-facing content
 * where stable English labels are preferred).
 */
import { NextRequest } from 'next/server';

import {
  M365MailEnvelope,
  graphJson,
  isValidGraphId,
  m365ErrorResponse,
  normalizeMailEnvelope,
} from '@/lib/services/m365/graphApi';
import {
  decodeGraphPageToken,
  encodeGraphNextLink,
} from '@/lib/services/m365/graphPageToken';
import {
  GraphMailMessage,
  GraphMailRecipient,
  buildMailMarkdown,
  formatMailRecipient,
  mailAttachmentFileName,
} from '@/lib/services/m365/mailMarkdown';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import type { M365MailFilter } from '@/types/m365';

import { auth } from '@/auth';

const SCOPES = ['Mail.Read'];
const ENVELOPE_SELECT =
  '$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,' +
  'hasAttachments,isRead,flag,importance,toRecipients,ccRecipients,webLink';
const CONTENT_SELECT =
  '$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink';
const TEXT_BODY_HEADERS = {
  Prefer: 'outlook.body-content-type="text"',
};
const MAX_THREAD_MESSAGES = 50;

// Bounds worst-case distribution lists in the envelope payload.
const MAX_LIST_RECIPIENTS = 10;

// Chips the route accepts; 'flagged' is deliberately absent (see header).
const FILTER_CLAUSES: Partial<Record<M365MailFilter, string>> = {
  unread: 'isRead eq false',
  hasAttachments: 'hasAttachments eq true',
};

// Model-facing document labels — deliberately stable English (see header).
const MARKDOWN_COPY = {
  fromLabel: 'From',
  toLabel: 'To',
  ccLabel: 'Cc',
  dateLabel: 'Date',
  attachmentsNote:
    'This message has file attachments (not imported — attachment contents are never fetched).',
  noSubject: '(no subject)',
};

interface GraphListResponse {
  value?: unknown[];
  '@odata.nextLink'?: string;
}

// Fields the extended $select adds on top of what normalizeMailEnvelope
// reads. graphApi.ts is shared with parallel features, so the row-display
// fields are normalized locally here instead of in the shared normalizer.
interface GraphEnvelopeShape {
  from?: GraphMailRecipient;
  isRead?: boolean;
  flag?: { flagStatus?: string };
  importance?: string;
  toRecipients?: GraphMailRecipient[];
  ccRecipients?: GraphMailRecipient[];
}

/** Returns null when any value is not an accepted filter. */
function parseFilters(raw: string): M365MailFilter[] | null {
  const filters: M365MailFilter[] = [];
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (!value) continue;
    // Object.hasOwn, not `in`: prototype keys like "constructor" must 400.
    if (!Object.hasOwn(FILTER_CLAUSES, value)) return null;
    if (!filters.includes(value as M365MailFilter)) {
      filters.push(value as M365MailFilter);
    }
  }
  return filters;
}

function formatRecipientList(
  recipients: GraphMailRecipient[] | undefined,
): string | undefined {
  const formatted = (recipients ?? [])
    .slice(0, MAX_LIST_RECIPIENTS)
    .map((r) => formatMailRecipient(r))
    .filter(Boolean);
  if (formatted.length === 0) return undefined;
  const overflow = (recipients?.length ?? 0) > MAX_LIST_RECIPIENTS;
  return formatted.join(', ') + (overflow ? ' …' : '');
}

/** Spreads the shared normalizer, then adds the display-only fields. */
function toEnvelope(raw: unknown): M365MailEnvelope | null {
  const base = normalizeMailEnvelope(raw as never);
  if (!base) return null;
  const m = raw as GraphEnvelopeShape;
  const fromName = m.from?.emailAddress?.name?.trim();
  const fromAddress = m.from?.emailAddress?.address?.trim();
  const importance =
    m.importance === 'low' ||
    m.importance === 'normal' ||
    m.importance === 'high'
      ? m.importance
      : undefined;
  const to = formatRecipientList(m.toRecipients);
  const cc = formatRecipientList(m.ccRecipients);
  return {
    ...base,
    ...(fromName && { fromName }),
    ...(fromAddress && { fromAddress }),
    ...(m.isRead !== undefined && { isRead: !!m.isRead }),
    ...(m.flag?.flagStatus === 'flagged' && { isFlagged: true }),
    ...(importance && { importance }),
    ...(to && { to }),
    ...(cc && { cc }),
  };
}

function envelopePageResponse(data: GraphListResponse) {
  const envelopes = (data.value ?? [])
    .map(toEnvelope)
    .filter((e): e is M365MailEnvelope => e !== null);
  const nextLink = data['@odata.nextLink'];
  const nextToken = nextLink ? encodeGraphNextLink(nextLink) : undefined;
  return successResponse({ envelopes, ...(nextToken && { nextToken }) });
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;
  const query = params.get('q')?.trim() ?? '';
  const messageId = params.get('messageId');
  const conversationId = params.get('conversationId');
  const pageToken = params.get('pageToken');
  const rawFilters = params.get('filters');

  try {
    if (messageId) {
      if (!isValidGraphId(messageId)) {
        return badRequestResponse('Invalid messageId');
      }
      const message = await graphJson<GraphMailMessage>(
        req,
        SCOPES,
        `/me/messages/${encodeURIComponent(messageId)}?${CONTENT_SELECT}`,
        { headers: TEXT_BODY_HEADERS },
      );
      return successResponse({
        markdown: buildMailMarkdown([message], MARKDOWN_COPY),
        fileName: mailAttachmentFileName(message.subject, 'email'),
        webLink: message.webLink,
        messageCount: 1,
      });
    }

    if (conversationId) {
      if (!isValidGraphId(conversationId)) {
        return badRequestResponse('Invalid conversationId');
      }
      const escaped = conversationId.replace(/'/g, "''");
      const data = await graphJson<{ value?: GraphMailMessage[] }>(
        req,
        SCOPES,
        `/me/messages?$filter=conversationId eq '${encodeURIComponent(escaped)}'` +
          `&$top=${MAX_THREAD_MESSAGES}&${CONTENT_SELECT}`,
        { headers: TEXT_BODY_HEADERS },
      );
      const messages = (data.value ?? []).sort((a, b) =>
        (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''),
      );
      if (messages.length === 0) {
        return badRequestResponse('Conversation not found or empty');
      }
      return successResponse({
        markdown: buildMailMarkdown(messages, MARKDOWN_COPY),
        fileName: mailAttachmentFileName(messages[0]?.subject, 'email-thread'),
        webLink: messages[messages.length - 1]?.webLink,
        messageCount: messages.length,
      });
    }

    // Continuation: replay a validated prior nextLink verbatim. The link
    // already encodes the original query, so q/filters are ignored here.
    if (pageToken) {
      const nextLink = decodeGraphPageToken(pageToken);
      if (!nextLink) {
        return badRequestResponse('Invalid page token');
      }
      const data = await graphJson<GraphListResponse>(req, SCOPES, nextLink);
      return envelopePageResponse(data);
    }

    let filters: M365MailFilter[] = [];
    if (rawFilters !== null) {
      const parsed = parseFilters(rawFilters);
      if (parsed === null) {
        return badRequestResponse('Invalid filters');
      }
      filters = parsed;
    }

    // Envelope listing: recent inbox, or $search results. $search cannot be
    // combined with $filter/$orderby — Graph returns relevance order for
    // searches and the client applies chip filters locally (see header).
    let path: string;
    if (query) {
      path =
        `/me/messages?$search="${encodeURIComponent(query.replace(/"/g, ''))}"` +
        `&$top=25&${ENVELOPE_SELECT}`;
    } else {
      path =
        `/me/mailFolders/inbox/messages?$top=25&${ENVELOPE_SELECT}` +
        '&$orderby=receivedDateTime desc';
      if (filters.length > 0) {
        // Graph requires every $orderby property to lead the $filter when
        // both are used on /messages — hence the receivedDateTime guard.
        const clauses = [
          'receivedDateTime ge 1900-01-01T00:00:00Z',
          ...filters.map((f) => FILTER_CLAUSES[f] as string),
        ];
        path += `&$filter=${clauses.join(' and ')}`;
      }
    }
    const data = await graphJson<GraphListResponse>(req, SCOPES, path);
    return envelopePageResponse(data);
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
