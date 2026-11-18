import {
  messageText,
  withMessageText,
} from '@/lib/utils/shared/chat/messageText';

import { Message } from '@/types/chat';

import { describe, expect, it } from 'vitest';

type Content = Message['content'];

const FILE = {
  type: 'file_url',
  url: '/api/file/a.txt',
  originalFilename: 'a.txt',
};
const IMAGE = {
  type: 'image_url',
  image_url: { url: '/api/file/b.png', detail: 'auto' },
};

/** Builds list-shaped content without restating the union at each call. */
const parts = (...items: unknown[]): Content => items as Content;

describe('messageText', () => {
  it('returns a plain string unchanged, line breaks included', () => {
    expect(messageText('first\n\nsecond')).toBe('first\n\nsecond');
  });

  it('returns the text of a message that also carries an upload', () => {
    expect(
      messageText(parts(FILE, { type: 'text', text: 'see **this**' })),
    ).toBe('see **this**');
  });

  it('joins several text parts with a blank line', () => {
    expect(
      messageText(
        parts({ type: 'text', text: 'one' }, IMAGE, {
          type: 'text',
          text: 'two',
        }),
      ),
    ).toBe('one\n\ntwo');
  });

  it('is empty for an upload with no caption', () => {
    expect(messageText(parts(FILE, IMAGE))).toBe('');
  });

  it('reads a single text part', () => {
    expect(messageText({ type: 'text', text: 'solo' })).toBe('solo');
  });

  it('is empty for content with no text slot', () => {
    expect(
      messageText({ type: 'extraction_result' } as unknown as Content),
    ).toBe('');
  });
});

describe('withMessageText', () => {
  it('replaces a plain string', () => {
    expect(withMessageText('old', 'new')).toBe('new');
  });

  it('keeps every upload when the caption is edited', () => {
    const edited = withMessageText(
      parts(FILE, IMAGE, { type: 'text', text: 'old' }),
      'new',
    );
    expect(edited).toEqual([FILE, IMAGE, { type: 'text', text: 'new' }]);
  });

  it('keeps the text where it was among the uploads', () => {
    const edited = withMessageText(
      parts({ type: 'text', text: 'old' }, FILE),
      'new',
    );
    expect(edited).toEqual([{ type: 'text', text: 'new' }, FILE]);
  });

  it('adds a caption after the uploads when there was none', () => {
    expect(withMessageText(parts(FILE), 'caption')).toEqual([
      FILE,
      { type: 'text', text: 'caption' },
    ]);
  });

  it('collapses several text parts into one', () => {
    const edited = withMessageText(
      parts({ type: 'text', text: 'a' }, FILE, { type: 'text', text: 'b' }),
      'merged',
    );
    expect(edited).toEqual([{ type: 'text', text: 'merged' }, FILE]);
  });

  it('round-trips: the text read back is the text written', () => {
    const content = parts(FILE, { type: 'text', text: 'old' });
    expect(messageText(withMessageText(content, 'line 1\n\nline 2'))).toBe(
      'line 1\n\nline 2',
    );
  });

  it('does not mutate the content it was given', () => {
    const content = parts(FILE, { type: 'text', text: 'old' });
    withMessageText(content, 'new');
    expect(content).toEqual([FILE, { type: 'text', text: 'old' }]);
  });

  it('replaces a single text part and leaves text-less content alone', () => {
    expect(withMessageText({ type: 'text', text: 'old' }, 'new')).toEqual({
      type: 'text',
      text: 'new',
    });
    const extraction = { type: 'extraction_result' } as unknown as Content;
    expect(withMessageText(extraction, 'new')).toBe(extraction);
  });
});
