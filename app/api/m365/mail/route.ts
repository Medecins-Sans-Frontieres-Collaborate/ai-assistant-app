/**
 * Outlook mail listing + import for the M365 mail-import flow.
 *
 * GET /api/m365/mail                      → recent inbox envelopes
 * GET /api/m365/mail?q=…                  → search envelopes
 * GET /api/m365/mail?messageId=…          → one message rendered as markdown
 * GET /api/m365/mail?conversationId=…     → the whole thread as markdown
 *
 * Read-only (`Mail.Read`). Bodies are requested as plain text via the
 * `Prefer: outlook.body-content-type="text"` header, so no HTML handling
 * happens anywhere. Attachment contents are never fetched — the rendered
 * document lists their names only.
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
  GraphMailMessage,
  buildMailMarkdown,
  mailAttachmentFileName,
} from '@/lib/services/m365/mailMarkdown';

import {
  badRequestResponse,
  successResponse,
  unauthorizedResponse,
} from '@/lib/utils/server/api/apiResponse';

import { auth } from '@/auth';

const SCOPES = ['Mail.Read'];
const ENVELOPE_SELECT =
  '$select=id,conversationId,subject,from,receivedDateTime,bodyPreview,hasAttachments,webLink';
const CONTENT_SELECT =
  '$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink';
const TEXT_BODY_HEADERS = {
  Prefer: 'outlook.body-content-type="text"',
};
const MAX_THREAD_MESSAGES = 50;

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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorizedResponse();
  }

  const params = req.nextUrl.searchParams;
  const query = params.get('q')?.trim() ?? '';
  const messageId = params.get('messageId');
  const conversationId = params.get('conversationId');

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

    // Envelope listing: recent inbox, or $search results. $search cannot be
    // combined with $orderby — Graph returns relevance order for searches.
    const path = query
      ? `/me/messages?$search="${encodeURIComponent(query.replace(/"/g, ''))}"` +
        `&$top=25&${ENVELOPE_SELECT}`
      : `/me/mailFolders/inbox/messages?$top=25&${ENVELOPE_SELECT}` +
        '&$orderby=receivedDateTime desc';
    const data = await graphJson<{ value?: unknown[] }>(req, SCOPES, path);
    const envelopes = (data.value ?? [])
      .map((m) => normalizeMailEnvelope(m as never))
      .filter((e): e is M365MailEnvelope => e !== null);
    return successResponse({ envelopes });
  } catch (error) {
    return m365ErrorResponse(error);
  }
}
