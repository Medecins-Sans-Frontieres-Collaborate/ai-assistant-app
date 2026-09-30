import {
  buildChannelPreview,
  displayLink,
  foldIndex,
  tokenize,
} from '@/lib/utils/shared/drafter/channels/channelPreview';
import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { Segment } from '@/types/drafter';

import { describe, expect, it } from 'vitest';

const linkedin = getChannelProfile('linkedin')!;
const x = getChannelProfile('x')!;

function seg(id: string, text: string): Segment {
  return { id, text, usedItemIds: [] };
}

describe('tokenize', () => {
  it('splits links, hashtags and mentions out of the text, keeping offsets', () => {
    const text =
      'Read https://www.example.org/reports/2026. #WaterCrisis @msf_intl now';
    const tokens = tokenize(text);
    expect(tokens.map((t) => [t.kind, t.display])).toEqual([
      ['text', 'Read '],
      ['link', 'example.org/reports/2026'],
      ['text', '. '],
      ['hashtag', '#WaterCrisis'],
      ['text', ' '],
      ['mention', '@msf_intl'],
      ['text', ' now'],
    ]);
    for (const token of tokens.filter((t) => t.kind !== 'link')) {
      expect(text.slice(token.start, token.start + token.display.length)).toBe(
        token.display,
      );
    }
    expect(text.slice(tokens[1].start).startsWith('https://')).toBe(true);
  });

  it('does not read an email address or a mid-word # as a tag', () => {
    const tokens = tokenize('Write to press@example.org about C#sharp');
    expect(tokens.every((t) => t.kind === 'text')).toBe(true);
  });

  it('shows a long link cut short, the way platforms do', () => {
    const shown = displayLink(
      'https://example.org/a/very/long/path/that/keeps/going/and/going',
    );
    expect(shown.length).toBe(32);
    expect(shown.endsWith('…')).toBe(true);
    expect(displayLink('https://www.example.org/')).toBe('example.org');
  });
});

describe('the fold', () => {
  it('sits at the end of a first line that fits the opening-line slot', () => {
    const text = 'A short opening line.\n\nThe rest of the post.';
    expect(foldIndex(linkedin, text)).toBe(text.indexOf('\n'));
  });

  it('cuts inside a first line that is too long, at a word', () => {
    const text = `${'word '.repeat(40)}end`;
    const at = foldIndex(linkedin, text)!;
    expect(at).toBeLessThanOrEqual(120);
    expect(text[at]).toBe(' ');
  });

  it('does not fold a post with nothing behind it, or a channel with no fold', () => {
    expect(foldIndex(linkedin, 'Just one line.')).toBeNull();
    expect(foldIndex(x, 'A line.\n\nMore.')).toBeNull();
  });
});

describe('buildChannelPreview', () => {
  it('agrees with the checks: the same fold, the same verdict', () => {
    const [post] = buildChannelPreview(linkedin, [
      seg('s1', 'The opening line.\n\nBehind the fold. https://example.org/x'),
    ]);
    expect(post.visible.map((t) => t.display).join('')).toBe(
      'The opening line.',
    );
    expect(post.foldLabelKey).toBe('seeMore');
    expect(post.hidden.some((t) => t.kind === 'link')).toBe(true);
    expect(post.over).toBe(0);
    expect(post.limit).toBe(3000);
  });

  it('numbers a thread and carries an over-limit post’s verdict', () => {
    const posts = buildChannelPreview(x, [
      seg('a', 'a'.repeat(300)),
      seg('b', 'Second.'),
    ]);
    expect(posts.map((p) => p.numbering)).toEqual(['1/2', '2/2']);
    expect(posts[0].over).toBeGreaterThan(0);
    expect(posts[1].over).toBe(0);
    expect(posts[0].hidden).toEqual([]);
  });

  it('does not number a single post', () => {
    expect(
      buildChannelPreview(x, [seg('a', 'Only one.')])[0].numbering,
    ).toBeUndefined();
  });

  it('collapses runs of blank lines, as platforms do', () => {
    const [post] = buildChannelPreview(x, [seg('a', 'One.\n\n\n\n\nTwo.')]);
    expect(post.visible.map((t) => t.display).join('')).toBe('One.\n\nTwo.');
  });
});
