import {
  CapturedPaste,
  getPasteOptions,
  hasDistinctMarkdown,
} from '@/client/services/paste/pasteOptions';

import { describe, expect, it } from 'vitest';

function paste(overrides: Partial<CapturedPaste> = {}): CapturedPaste {
  return { text: '', markdown: '', imageFiles: [], ...overrides };
}

const ids = (p: CapturedPaste) => getPasteOptions(p).map((o) => o.id);

describe('getPasteOptions', () => {
  it('offers nothing for an empty clipboard', () => {
    expect(ids(paste())).toEqual([]);
  });

  it('offers insert-as-text and attach-as-text for plain text', () => {
    expect(ids(paste({ text: 'hello' }))).toEqual(['text', 'attachText']);
  });

  it('treats whitespace-only text as no text', () => {
    expect(ids(paste({ text: '  \n ' }))).toEqual([]);
  });

  it('offers only the image option for a screenshot', () => {
    const image = new File(['x'], 'image.png', { type: 'image/png' });
    expect(getPasteOptions(paste({ imageFiles: [image] }))).toEqual([
      { id: 'image', section: 'attach', count: 1 },
    ]);
  });

  it('counts multiple images', () => {
    const image = new File(['x'], 'image.png', { type: 'image/png' });
    const [option] = getPasteOptions(paste({ imageFiles: [image, image] }));
    expect(option.count).toBe(2);
  });

  it('offers text, markdown, both attachments and image for a Word paste', () => {
    const image = new File(['x'], 'image.png', { type: 'image/png' });
    expect(
      ids(
        paste({
          text: 'Heading\nBody text',
          markdown: '# Heading\n\n**Body** text',
          imageFiles: [image],
        }),
      ),
    ).toEqual(['text', 'markdown', 'attachText', 'attachMarkdown', 'image']);
  });

  it('hides the markdown options when the HTML adds no formatting', () => {
    expect(
      ids(paste({ text: 'just a sentence', markdown: 'just  a\nsentence' })),
    ).toEqual(['text', 'attachText']);
  });

  it('offers the link option only when the text is a single URL', () => {
    expect(ids(paste({ text: 'https://example.org/page' }))).toEqual([
      'text',
      'attachText',
      'link',
    ]);
    expect(ids(paste({ text: 'see https://example.org/page' }))).toEqual([
      'text',
      'attachText',
    ]);
  });

  it('places insert options before attach options', () => {
    const sections = getPasteOptions(
      paste({ text: 'a', markdown: '**a**' }),
    ).map((o) => o.section);
    expect(sections).toEqual(['insert', 'insert', 'attach', 'attach']);
  });
});

describe('hasDistinctMarkdown', () => {
  it('is false without markdown', () => {
    expect(hasDistinctMarkdown(paste({ text: 'x' }))).toBe(false);
  });

  it('ignores whitespace differences', () => {
    expect(
      hasDistinctMarkdown(paste({ text: 'a b', markdown: 'a\n\nb' })),
    ).toBe(false);
  });

  it('is true when markup survives', () => {
    expect(
      hasDistinctMarkdown(paste({ text: 'a b', markdown: '**a** b' })),
    ).toBe(true);
  });
});
