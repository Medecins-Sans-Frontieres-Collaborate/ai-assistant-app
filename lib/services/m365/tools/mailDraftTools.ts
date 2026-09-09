/**
 * Mail draft tools (fifth pass tier 2): mail_create_draft,
 * mail_create_reply_draft, mail_update_draft, mail_add_draft_attachment.
 *
 * Safety posture (docs/M365_FIFTH_PASS_MAIL_TOOLS_DESIGN.md):
 * - Drafts are NEVER sent here — they land in Outlook's Drafts folder and
 *   every result carries the webLink as an "Open in Outlook" line, because
 *   the expected flow ends in Outlook, not in the app.
 * - App-draft marker: every draft this app creates is stamped with a
 *   singleValueExtendedProperty (String {66f5a359-4659-4830-9070-00047ec6ac6e}
 *   Name x-ai-assistant-draft = '1'). The extended property is used for BOTH
 *   create paths — Graph's internetMessageHeaders are create-only and cannot
 *   be PATCHed onto the draft that createReply/createReplyAll returns, so a
 *   header marker could never cover reply drafts; one uniform mechanism
 *   keeps the update/attachment verification single-pathed. The marker is
 *   the stateless allow-list from disposition 7: update/attach refuse any
 *   draft that does not carry it.
 * - Reply targets pass the phishing screen first (mailScreen); a flagged,
 *   un-overridden message is refused as a reply target. Override ids come
 *   only from the request payload (ctx.screenOverrideIds) — never from tool
 *   arguments — so an injected instruction cannot self-unlock.
 * - Attachments resolve bytes server-side from the user's OWN upload storage
 *   (`{userId}/uploads/files/…`) — only app files, never mailbox/drive
 *   content, and never via the HTTP file route.
 *
 * graphApi and the blob client are lazy-imported inside the async bodies so
 * this module graph stays free of next-auth/Azure SDKs (see shared.ts).
 */
import { Session } from 'next-auth';
import { NextRequest } from 'next/server';

import type { M365ToolExecutionContext } from '@/lib/services/m365/tools/executor';
import { M365ToolUserFacingError } from '@/lib/services/m365/tools/executor';
import { screenMailMessage } from '@/lib/services/m365/tools/mailScreen';
import {
  M365ToolInputError,
  catalogScopes,
  isValidEmail,
  optionalString,
  requireString,
  truncateText,
} from '@/lib/services/m365/tools/shared';

/** MAPI extended property that marks a draft as created by this app. */
export const DRAFT_MARKER_PROPERTY_ID =
  'String {66f5a359-4659-4830-9070-00047ec6ac6e} Name x-ai-assistant-draft';
const DRAFT_MARKER_VALUE = '1';

const MAX_RECIPIENTS_TOTAL = 50;
const MAX_SUBJECT_CHARS = 300;
const MAX_BODY_CHARS = 50_000;
/** Graph's inline fileAttachment ceiling; larger goes via upload session. */
const INLINE_ATTACHMENT_MAX = 3 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// 16 × 320KiB — Graph upload-session fragments must be 320KiB multiples
// (mirrors app/api/m365/save/route.ts).
const UPLOAD_CHUNK_SIZE = 16 * 327_680;

const NOT_APP_DRAFT_MESSAGE =
  'Only drafts created by this assistant can be updated.';

/** App upload references only — the /api/file/<uuid>.<ext> shape. */
const FILE_URI_REGEX = /^\/api\/file\/[A-Za-z0-9-]+\.[A-Za-z0-9]+$/;

interface GraphRecipient {
  emailAddress?: { name?: string; address?: string };
}

interface GraphDraftMessage {
  id?: string;
  subject?: string;
  isDraft?: boolean;
  body?: { contentType?: string; content?: string };
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  from?: GraphRecipient;
  replyTo?: GraphRecipient[];
  internetMessageHeaders?: { name?: string; value?: string }[];
  singleValueExtendedProperties?: { id?: string; value?: string }[];
  webLink?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Validates a recipient-array argument: every entry a syntactically valid
 * email. `required` additionally rejects absent/empty — a draft with no To
 * recipient is unaddressable.
 */
function parseRecipients(
  args: Record<string, unknown>,
  key: string,
  required = false,
): string[] | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) {
    if (required) {
      throw new M365ToolInputError(`${key} is required`);
    }
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new M365ToolInputError(`${key} must be an array of email addresses`);
  }
  const list = raw.map((entry) => {
    if (!isValidEmail(entry)) {
      throw new M365ToolInputError(
        `${key} contains an invalid email address: ${truncateText(String(entry), 60)}`,
      );
    }
    return entry.trim();
  });
  if (required && list.length === 0) {
    throw new M365ToolInputError(`${key} must contain at least one recipient`);
  }
  return list;
}

function assertRecipientTotal(...lists: (string[] | undefined)[]): void {
  const total = lists.reduce((sum, list) => sum + (list?.length ?? 0), 0);
  if (total > MAX_RECIPIENTS_TOTAL) {
    throw new M365ToolInputError(
      `Too many recipients (${total}) — the maximum is ${MAX_RECIPIENTS_TOTAL}`,
    );
  }
}

function validateSubject(subject: string): string {
  if (subject.length > MAX_SUBJECT_CHARS) {
    throw new M365ToolInputError(
      `subject is too long (${subject.length} characters; maximum ${MAX_SUBJECT_CHARS})`,
    );
  }
  return subject;
}

function validateBody(body: string): string {
  if (body.length > MAX_BODY_CHARS) {
    throw new M365ToolInputError(
      `body is too long (${body.length} characters; maximum ${MAX_BODY_CHARS})`,
    );
  }
  return body;
}

function parseImportance(args: Record<string, unknown>): string | undefined {
  const importance = optionalString(args, 'importance');
  if (importance === undefined) return undefined;
  if (!['low', 'normal', 'high'].includes(importance)) {
    throw new M365ToolInputError('importance must be low, normal or high');
  }
  return importance;
}

function requireGraphId(
  value: string,
  key: string,
  isValid: (id: string) => boolean,
): string {
  if (!isValid(value)) {
    throw new M365ToolInputError(`${key} is not a valid message id`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Body shaping
// ---------------------------------------------------------------------------

/**
 * v1 composes simple HTML only (paragraphs, lists, links — disposition 3);
 * this detection mirrors that contract: the model either sends plain text
 * or simple HTML using exactly these constructs.
 */
function looksLikeSimpleHtml(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('<p') || lower.includes('<ul') || lower.includes('<a ');
}

function graphBody(body: string): { contentType: string; content: string } {
  return {
    contentType: looksLikeSimpleHtml(body) ? 'html' : 'text',
    content: body,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Plain text → simple HTML paragraphs, for prepending into an HTML draft. */
function textToSimpleHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

function toGraphRecipients(addresses: string[]): GraphRecipient[] {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

function recipientCount(message: GraphDraftMessage): number {
  return (
    (message.toRecipients?.length ?? 0) +
    (message.ccRecipients?.length ?? 0) +
    (message.bccRecipients?.length ?? 0)
  );
}

function openInOutlookLine(webLink: string | undefined): string {
  return webLink ? `\nOpen in Outlook: ${webLink}` : '';
}

// ---------------------------------------------------------------------------
// App-draft marker verification (stateless allow-list, disposition 7)
// ---------------------------------------------------------------------------

const markerExpand = `$expand=singleValueExtendedProperties($filter=${encodeURIComponent(
  `id eq '${DRAFT_MARKER_PROPERTY_ID}'`,
)})`;

/**
 * Fetches a draft and verifies it is (a) still a draft and (b) stamped with
 * the app marker. Anything else — including sent messages and drafts the
 * user created themselves in Outlook — is refused: the assistant must never
 * modify mail it did not create.
 */
async function requireAppDraft(
  req: NextRequest,
  scopes: string[],
  draftId: string,
): Promise<GraphDraftMessage> {
  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const draft = await graphJson<GraphDraftMessage>(
    req,
    scopes,
    `/me/messages/${encodeURIComponent(draftId)}` +
      `?$select=isDraft,subject,toRecipients,webLink&${markerExpand}`,
  );
  // The $expand is already filtered to the marker property id; any returned
  // entry carrying the marker value proves app provenance (id comparison is
  // skipped deliberately — Graph normalizes the property-id casing).
  const marked = (draft.singleValueExtendedProperties ?? []).some(
    (property) => property?.value === DRAFT_MARKER_VALUE,
  );
  if (!draft.isDraft || !marked) {
    throw new Error(NOT_APP_DRAFT_MESSAGE);
  }
  return draft;
}

// ---------------------------------------------------------------------------
// mail_create_draft
// ---------------------------------------------------------------------------

export async function mailCreateDraft(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
  _ctx: M365ToolExecutionContext,
): Promise<string> {
  const to = parseRecipients(args, 'to', true) as string[];
  const cc = parseRecipients(args, 'cc');
  const bcc = parseRecipients(args, 'bcc');
  assertRecipientTotal(to, cc, bcc);
  const subject = validateSubject(requireString(args, 'subject'));
  const body = validateBody(requireString(args, 'body'));
  const importance = parseImportance(args);

  const { graphJson } = await import('@/lib/services/m365/graphApi');
  const created = await graphJson<GraphDraftMessage>(
    req,
    catalogScopes('mail_create_draft'),
    '/me/messages',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject,
        body: graphBody(body),
        toRecipients: toGraphRecipients(to),
        ...(cc && cc.length > 0 && { ccRecipients: toGraphRecipients(cc) }),
        ...(bcc && bcc.length > 0 && { bccRecipients: toGraphRecipients(bcc) }),
        ...(importance && { importance }),
        // App-draft marker (see module header for why not a custom internet
        // message header).
        singleValueExtendedProperties: [
          { id: DRAFT_MARKER_PROPERTY_ID, value: DRAFT_MARKER_VALUE },
        ],
      }),
    },
  );

  const total = to.length + (cc?.length ?? 0) + (bcc?.length ?? 0);
  return (
    `Draft created (NOT sent) — "${subject}", ${total} recipient(s).` +
    `\nDraft id: ${created.id ?? 'unknown'}` +
    openInOutlookLine(created.webLink)
  );
}

// ---------------------------------------------------------------------------
// mail_create_reply_draft
// ---------------------------------------------------------------------------

export async function mailCreateReplyDraft(
  req: NextRequest,
  session: Session,
  args: Record<string, unknown>,
  ctx: M365ToolExecutionContext,
): Promise<string> {
  const body = validateBody(requireString(args, 'body'));
  const replyAll = args.replyAll === true;

  const { graphJson, isValidGraphId } =
    await import('@/lib/services/m365/graphApi');
  const messageId = requireGraphId(
    requireString(args, 'messageId'),
    'messageId',
    isValidGraphId,
  );
  const scopes = catalogScopes('mail_create_reply_draft');

  // Screen the reply TARGET before anything is built from it — a flagged
  // message must not become a reply thread unless the user explicitly
  // overrode the flag via the UI (ids ride the request payload, never tool
  // arguments). Text body preferred so the screen sees what a reader sees.
  const target = await graphJson<GraphDraftMessage>(
    req,
    scopes,
    `/me/messages/${encodeURIComponent(messageId)}` +
      '?$select=subject,from,replyTo,body,internetMessageHeaders',
    { headers: { Prefer: 'outlook.body-content-type="text"' } },
  );
  const verdict = await screenMailMessage(
    req,
    session,
    {
      messageId,
      from: target.from?.emailAddress?.address,
      replyTo: target.replyTo?.[0]?.emailAddress?.address,
      subject: target.subject,
      bodyText: target.body?.content ?? '',
      headers: target.internetMessageHeaders,
    },
    { overrideIds: ctx.screenOverrideIds },
  );
  if (verdict.verdict === 'suspicious' && !verdict.overridden) {
    throw new M365ToolUserFacingError(
      `This message was flagged by the phishing screen (reasons: ${verdict.reasons.join(
        '; ',
      )}). Ask the user to review the flag before drafting a reply.`,
    );
  }

  // Graph's reply builders produce Outlook-correct threading headers,
  // subject prefixes and quoted history; the model's body is then PREPENDED
  // above that quoted history.
  const created = await graphJson<GraphDraftMessage>(
    req,
    scopes,
    `/me/messages/${encodeURIComponent(messageId)}/${
      replyAll ? 'createReplyAll' : 'createReply'
    }`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  if (!created.id) {
    throw new Error('Graph did not return the created reply draft');
  }

  const quoted = created.body?.content ?? '';
  const draftIsHtml = (created.body?.contentType ?? 'html') === 'html';
  const content = draftIsHtml
    ? (looksLikeSimpleHtml(body) ? body : textToSimpleHtml(body)) + quoted
    : `${body}\n\n${quoted}`;

  const patched = await graphJson<GraphDraftMessage>(
    req,
    scopes,
    `/me/messages/${encodeURIComponent(created.id)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          contentType: draftIsHtml ? 'html' : 'text',
          content,
        },
        // Reply drafts get the same app marker as fresh drafts — PATCH is
        // the only place it can be set on a createReply-built draft.
        singleValueExtendedProperties: [
          { id: DRAFT_MARKER_PROPERTY_ID, value: DRAFT_MARKER_VALUE },
        ],
      }),
    },
  );

  const recipients = recipientCount(created);
  return (
    `Reply draft created (NOT sent) — reply-all: ${replyAll ? 'yes' : 'no'}, ` +
    `${recipients} recipient(s).` +
    `\nDraft id: ${created.id}` +
    openInOutlookLine(patched.webLink ?? created.webLink)
  );
}

// ---------------------------------------------------------------------------
// mail_update_draft
// ---------------------------------------------------------------------------

export async function mailUpdateDraft(
  req: NextRequest,
  _session: Session,
  args: Record<string, unknown>,
  _ctx: M365ToolExecutionContext,
): Promise<string> {
  const { graphJson, isValidGraphId } =
    await import('@/lib/services/m365/graphApi');
  const draftId = requireGraphId(
    requireString(args, 'draftId'),
    'draftId',
    isValidGraphId,
  );

  // Recipient arrays replace WHOLESALE — same validation as create. An
  // empty `to` would leave the draft unaddressable, so it is rejected; an
  // empty `cc` legitimately clears the Cc line.
  const to = parseRecipients(args, 'to');
  if (to !== undefined && to.length === 0) {
    throw new M365ToolInputError('to must contain at least one recipient');
  }
  const cc = parseRecipients(args, 'cc');
  assertRecipientTotal(to, cc);
  const rawSubject = optionalString(args, 'subject');
  const subject =
    rawSubject === undefined ? undefined : validateSubject(rawSubject);
  const rawBody = optionalString(args, 'body');
  const body = rawBody === undefined ? undefined : validateBody(rawBody);

  if (!to && !cc && subject === undefined && body === undefined) {
    throw new M365ToolInputError(
      'Nothing to update — provide to, cc, subject or body',
    );
  }

  const scopes = catalogScopes('mail_update_draft');
  const existing = await requireAppDraft(req, scopes, draftId);

  const patched = await graphJson<GraphDraftMessage>(
    req,
    scopes,
    `/me/messages/${encodeURIComponent(draftId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(to && { toRecipients: toGraphRecipients(to) }),
        ...(cc && { ccRecipients: toGraphRecipients(cc) }),
        ...(subject !== undefined && { subject }),
        ...(body !== undefined && { body: graphBody(body) }),
      }),
    },
  );

  const changed = [
    ...(to ? [`to (${to.length})`] : []),
    ...(cc ? [`cc (${cc.length})`] : []),
    ...(subject !== undefined ? ['subject'] : []),
    ...(body !== undefined ? ['body'] : []),
  ].join(', ');
  const finalSubject =
    subject ?? patched.subject ?? existing.subject ?? '(no subject)';
  return (
    `Draft updated (NOT sent) — "${finalSubject}". Changed: ${changed}.` +
    openInOutlookLine(patched.webLink ?? existing.webLink)
  );
}

// ---------------------------------------------------------------------------
// mail_add_draft_attachment
// ---------------------------------------------------------------------------

/** Fragments go straight to the pre-authenticated uploadUrl (no token). */
async function uploadAttachmentFragments(
  uploadUrl: string,
  bytes: Uint8Array,
): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_SIZE) {
    const end = Math.min(offset + UPLOAD_CHUNK_SIZE, bytes.length);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
      },
      body: bytes.slice(offset, end),
    });
    if (!response.ok) {
      throw new Error(`Attachment chunk upload failed (${response.status})`);
    }
  }
}

export async function mailAddDraftAttachment(
  req: NextRequest,
  session: Session,
  args: Record<string, unknown>,
  ctx: M365ToolExecutionContext,
): Promise<string> {
  const { graphJson, isValidGraphId } =
    await import('@/lib/services/m365/graphApi');
  const draftId = requireGraphId(
    requireString(args, 'draftId'),
    'draftId',
    isValidGraphId,
  );
  const fileUri = requireString(args, 'fileUri');
  if (!FILE_URI_REGEX.test(fileUri)) {
    throw new M365ToolInputError(
      'fileUri must be an app file reference like /api/file/<id>.<ext>',
    );
  }
  const fileName = truncateText(requireString(args, 'fileName'), 255);

  const scopes = catalogScopes('mail_add_draft_attachment');
  // Same app-marker gate as update: only drafts this assistant created can
  // receive attachments.
  const draft = await requireAppDraft(req, scopes, draftId);
  const draftSubject = draft.subject ?? '(no subject)';

  // Resolve the BYTES server-side from the user's own upload storage —
  // never through the HTTP file route. Only `{userId}/uploads/files/…` is
  // reachable, which is exactly the app-produced/user-uploaded space; the
  // fileUri shape check above prevents any path traversal into it.
  const blobId = fileUri.split('/').pop() as string;
  const blobPath = `${session.user.id}/uploads/files/${blobId}`;
  const [{ createBlobStorageClient }, { BlobProperty }] = await Promise.all([
    import('@/lib/services/blobStorageFactory'),
    import('@/lib/utils/server/blob/blob'),
  ]);
  const blobStorage = createBlobStorageClient(session);

  const size = await blobStorage.getBlobSize(blobPath);
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `The file is too large to attach (${Math.ceil(size / (1024 * 1024))}MB — the limit is 25MB).`,
    );
  }
  const bytes = (await blobStorage.get(blobPath, BlobProperty.BLOB)) as Buffer;

  if (bytes.length <= INLINE_ATTACHMENT_MAX) {
    await graphJson(
      req,
      scopes,
      `/me/messages/${encodeURIComponent(draftId)}/attachments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: fileName,
          contentBytes: bytes.toString('base64'),
        }),
      },
    );
  } else {
    ctx.emitActivity?.(
      `Uploading ${fileName} (${Math.ceil(bytes.length / (1024 * 1024))}MB)…`,
    );
    const uploadSession = await graphJson<{ uploadUrl?: string }>(
      req,
      scopes,
      `/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: 'file',
            name: fileName,
            size: bytes.length,
          },
        }),
      },
    );
    if (!uploadSession.uploadUrl) {
      throw new Error('Attachment upload session was not created');
    }
    await uploadAttachmentFragments(
      uploadSession.uploadUrl,
      new Uint8Array(bytes),
    );
  }

  return (
    `Attached "${fileName}" to draft "${draftSubject}" (NOT sent).` +
    openInOutlookLine(draft.webLink)
  );
}
