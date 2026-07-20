import {
  attachmentFileName,
  buildFailureDocument,
  buildPageDocument,
  makeTextFile,
  shortHash,
} from '@/client/services/url/urlAttachment';
import type { FetchedPage } from '@/client/services/url/urlFetchClient';

import { describe, expect, it } from 'vitest';

const FIXED = new Date('2026-07-18T09:30:00.000Z');

const page: FetchedPage = {
  text: 'Floodwaters reached Bor on Tuesday.',
  title: 'Floods displace thousands',
  siteName: 'Example News',
  resolvedUrl: 'https://news.example.com/floods',
  truncated: false,
  extractedVia: 'readability',
};

const pageCopy = { sourceLabel: 'Source', retrievedLabel: 'Retrieved' };

const failureCopy = {
  heading: 'Web page could not be retrieved',
  sourceLabel: 'Source',
  attemptedLabel: 'Attempted',
  reason: 'The site refused the request.',
  hint: 'Open the page and paste the text instead.',
};

describe('buildPageDocument', () => {
  it('leads with the title and records provenance', () => {
    const doc = buildPageDocument(page, pageCopy, FIXED);

    expect(doc).toContain('# Floods displace thousands');
    expect(doc).toContain('Source: https://news.example.com/floods');
    expect(doc).toContain('Retrieved: 2026-07-18T09:30:00.000Z');
    expect(doc).toContain('Floodwaters reached Bor on Tuesday.');
  });

  it('falls back to the hostname when the page has no title', () => {
    const doc = buildPageDocument({ ...page, title: '' }, pageCopy, FIXED);
    expect(doc).toContain('# news.example.com');
  });
});

describe('buildFailureDocument', () => {
  /**
   * The point of the whole failure path: the attachment still carries usable
   * information, so the model is told why a link it was shown is empty rather
   * than being left to guess.
   */
  it('explains the failure and what to do instead', () => {
    const doc = buildFailureDocument(
      'https://paywalled.example.com/x',
      failureCopy,
      FIXED,
    );

    expect(doc).toContain('# Web page could not be retrieved');
    expect(doc).toContain('Source: https://paywalled.example.com/x');
    expect(doc).toContain('Attempted: 2026-07-18T09:30:00.000Z');
    expect(doc).toContain('The site refused the request.');
    expect(doc).toContain('Open the page and paste the text instead.');
  });

  it('is never empty, so the attachment always has content', () => {
    const doc = buildFailureDocument('https://x.example.com', failureCopy);
    expect(doc.trim().length).toBeGreaterThan(40);
  });
});

describe('attachmentFileName', () => {
  it('slugifies the title and keeps the .md extension', () => {
    const name = attachmentFileName(
      'Floods displace thousands',
      'https://news.example.com/floods',
    );
    expect(name).toMatch(/^Floods displace thousands-[a-z0-9]+\.md$/);
  });

  it('strips characters that break filenames', () => {
    const name = attachmentFileName('a/b\\c:d*e?f"g<h>i|j#k', 'https://e.com');
    expect(name).not.toMatch(/[\\/:*?"<>|#]/);
  });

  it('marks a failed fetch distinctly', () => {
    expect(
      attachmentFileName('', 'https://e.example.com', { failed: true }),
    ).toContain('unavailable');
  });

  it('falls back to the hostname, then to a constant', () => {
    expect(attachmentFileName('', 'https://news.example.com/x')).toContain(
      'news.example.com',
    );
    expect(attachmentFileName('', 'not a url')).toContain('web-page');
  });

  /**
   * Previews and upload progress are keyed by filename, so two different
   * pages must not collide — and the same page twice must not look like two
   * unrelated files.
   */
  it('is stable per URL and distinct across URLs', () => {
    const a = attachmentFileName('Same Title', 'https://a.example.com/1');
    const b = attachmentFileName('Same Title', 'https://b.example.com/2');
    expect(a).not.toBe(b);
    expect(a).toBe(attachmentFileName('Same Title', 'https://a.example.com/1'));
  });
});

describe('shortHash', () => {
  it('is deterministic and differs across inputs', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
  });
});

/**
 * This suite runs under both the node and jsdom configs, and jsdom's `File`
 * has no `.text()` — fall back to FileReader there.
 */
function readFile(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

describe('makeTextFile', () => {
  it('produces a markdown File carrying the content', async () => {
    const file = makeTextFile('page.md', '# Hello');
    expect(file.name).toBe('page.md');
    expect(file.type).toBe('text/markdown');
    expect(await readFile(file)).toBe('# Hello');
  });
});
