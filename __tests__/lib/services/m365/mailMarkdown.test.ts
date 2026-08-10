import {
  GraphMailMessage,
  buildMailMarkdown,
  mailAttachmentFileName,
} from '@/lib/services/m365/mailMarkdown';

import { describe, expect, it } from 'vitest';

const COPY = {
  fromLabel: 'From',
  toLabel: 'To',
  ccLabel: 'Cc',
  dateLabel: 'Date',
  attachmentsNote: 'Has attachments (not imported)',
  noSubject: '(no subject)',
};

function message(overrides: Partial<GraphMailMessage> = {}): GraphMailMessage {
  return {
    id: 'm1',
    subject: 'Shipment delay',
    receivedDateTime: '2026-07-01T10:00:00Z',
    from: { emailAddress: { name: 'Maria R.', address: 'maria@example.org' } },
    toRecipients: [{ emailAddress: { address: 'blaze@example.org' } }],
    body: { contentType: 'text', content: 'The shipment slipped a week.' },
    ...overrides,
  };
}

describe('buildMailMarkdown', () => {
  it('renders a single message with headers and body', () => {
    const md = buildMailMarkdown([message()], COPY);
    expect(md).toContain('# Shipment delay');
    expect(md).toContain('**From:** Maria R. <maria@example.org>');
    expect(md).toContain('**To:** blaze@example.org');
    expect(md).toContain('**Date:** 2026-07-01T10:00:00Z');
    expect(md).toContain('The shipment slipped a week.');
    expect(md).not.toContain(COPY.attachmentsNote);
  });

  it('joins a thread in order with separators under the first subject', () => {
    const md = buildMailMarkdown(
      [
        message({ body: { content: 'First message' } }),
        message({
          subject: 'RE: Shipment delay',
          body: { content: 'Second message' },
        }),
      ],
      COPY,
    );
    expect(md.startsWith('# Shipment delay')).toBe(true);
    expect(md.indexOf('First message')).toBeLessThan(
      md.indexOf('Second message'),
    );
    expect(md).toContain('\n---\n');
    // The reply's own subject is not promoted to a heading.
    expect(md).not.toContain('# RE: Shipment delay');
  });

  it('notes attachments without importing them and falls back on subject', () => {
    const md = buildMailMarkdown(
      [message({ subject: '  ', hasAttachments: true })],
      COPY,
    );
    expect(md).toContain('# (no subject)');
    expect(md).toContain(COPY.attachmentsNote);
  });
});

describe('mailAttachmentFileName', () => {
  it('sanitizes unsafe characters and appends .md', () => {
    expect(mailAttachmentFileName('RE: budget / Q3?', 'email')).toBe(
      'RE- budget - Q3.md',
    );
  });

  it('falls back when the subject is empty', () => {
    expect(mailAttachmentFileName('   ', 'email-thread')).toBe(
      'email-thread.md',
    );
  });
});
