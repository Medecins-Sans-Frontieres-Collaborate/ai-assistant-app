/**
 * Renders imported Outlook messages/threads as a single Markdown document
 * for the attachment pipeline. Pure string building — bodies arrive as plain
 * text because the routes request `Prefer: outlook.body-content-type="text"`,
 * so no HTML handling happens here.
 *
 * Attachments are listed by name only; their content is deliberately never
 * fetched (metadata is safe, attacker-supplied file bytes are not).
 */
export interface GraphMailRecipient {
  emailAddress?: { name?: string; address?: string };
}

export function formatMailRecipient(
  recipient: GraphMailRecipient | undefined,
): string {
  const name = recipient?.emailAddress?.name?.trim();
  const address = recipient?.emailAddress?.address?.trim();
  if (name && address && name.toLowerCase() !== address.toLowerCase()) {
    return `${name} <${address}>`;
  }
  return address || name || '';
}

export interface GraphMailMessage {
  id?: string;
  subject?: string;
  receivedDateTime?: string;
  from?: GraphMailRecipient;
  toRecipients?: GraphMailRecipient[];
  ccRecipients?: GraphMailRecipient[];
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  webLink?: string;
}

export interface MailMarkdownCopy {
  fromLabel: string;
  toLabel: string;
  ccLabel: string;
  dateLabel: string;
  attachmentsNote: string;
  noSubject: string;
}

function recipientList(recipients: GraphMailRecipient[] | undefined): string {
  return (recipients ?? [])
    .map((r) => formatMailRecipient(r))
    .filter(Boolean)
    .join(', ');
}

function messageBlock(
  message: GraphMailMessage,
  copy: MailMarkdownCopy,
): string {
  const lines: string[] = [];
  const from = formatMailRecipient(message.from);
  if (from) lines.push(`**${copy.fromLabel}:** ${from}`);
  const to = recipientList(message.toRecipients);
  if (to) lines.push(`**${copy.toLabel}:** ${to}`);
  const cc = recipientList(message.ccRecipients);
  if (cc) lines.push(`**${copy.ccLabel}:** ${cc}`);
  if (message.receivedDateTime) {
    lines.push(`**${copy.dateLabel}:** ${message.receivedDateTime}`);
  }
  if (message.hasAttachments) {
    lines.push(`_${copy.attachmentsNote}_`);
  }
  const body = message.body?.content?.trim() ?? '';
  return `${lines.join('\n')}\n\n${body}\n`;
}

/**
 * One message → a document titled by its subject; several messages → the
 * thread in received order under the first subject, separated by rules.
 */
export function buildMailMarkdown(
  messages: GraphMailMessage[],
  copy: MailMarkdownCopy,
): string {
  const subject = messages[0]?.subject?.trim() || copy.noSubject;
  const blocks = messages.map((m) => messageBlock(m, copy));
  return `# ${subject}\n\n${blocks.join('\n---\n\n')}`;
}

/** Filesystem-safe markdown filename derived from the subject. */
export function mailAttachmentFileName(
  subject: string | undefined,
  fallback: string,
): string {
  const base = (subject?.trim() || fallback)
    .replace(/[\\/:*?"<>|#]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[-\s]+$/, '');
  return `${base || fallback}.md`;
}
